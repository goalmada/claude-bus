import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Adapter for review candidate files that existing workers already write beside the queue.
// Those workers publish a JSON checkpoint instead of calling `ready`, so without this adapter
// their finished work never reaches the coordination mechanism.
//
// The scope is deliberately narrow:
//   - Only `<queue root>/candidates/<file>` or `<queue root>/<file>` is ever read, by exact
//     registered name. No absolute path, no traversal, no symlink and no path supplied at read
//     time. Private state files (the queue, its lock, the native gate, the health record, the
//     coordinator roster, retained check output and tool audits) are never candidates.
//   - Only a file that was explicitly registered for one subject is read, and only by that
//     subject's owner or by a coordinator adopting an existing record.
//   - The same private file checks the native gate uses apply: regular file, owned by this
//     user, mode 0600, single link, bounded size.
//   - Only readiness facts are taken. Any approval, verification or deployment claim inside a
//     candidate file is ignored by construction: a worker cannot approve itself by writing a
//     file, and the observed filesystem time, not the file's own claim, is the elapsed clock.

export const CANDIDATE_DIRECTORY = 'candidates';
export const CANDIDATE_SIZE_LIMIT = 65536;
// Workers write their checkpoint either in the candidates directory or directly beside the
// queue. Both are supported by exact name; nothing else is ever read.
export const CANDIDATE_LOCATIONS = Object.freeze(['candidates', 'root']);
// Private state files that are never candidate documents, whatever a registration claims.
const RESERVED = new Set(['queue.json', 'queue.lock', 'native-max-verification.json', 'service-health.json', 'coordinators.json']);
const RESERVED_SUFFIX = /(-approved-check\.txt|-tools\.jsonl)$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const FULL_SHA = /^[a-f0-9]{40,64}$/;
const DIGEST = /^(sha256:)?[a-f0-9]{40,128}$/;
const DIGEST_KINDS = new Set(['result', 'artifact', 'checkpoint']);

const text = value => typeof value === 'string' && value.trim().length > 0;
const first = (...values) => values.find(value => text(value)) ?? null;

export function candidateFileName(name) {
  if (!text(name) || !FILE_NAME.test(name.trim()) || name.includes('..')) {
    throw new Error('Candidate file must be a plain JSON file name inside the private queue directory');
  }
  return name.trim();
}

export function candidateLocation(location) {
  if (location === undefined || location === null) return 'candidates';
  if (!CANDIDATE_LOCATIONS.includes(location)) throw new Error(`Candidate location must be one of ${CANDIDATE_LOCATIONS.join(', ')}`);
  return location;
}

export function candidatePath(root, name, location = 'candidates') {
  const file = candidateFileName(name);
  if (candidateLocation(location) === 'root') {
    if (RESERVED.has(file) || RESERVED_SUFFIX.test(file)) throw new Error('That private state file is not a review candidate');
    return path.join(root, file);
  }
  return path.join(root, CANDIDATE_DIRECTORY, file);
}

// Returns null when the registered file is simply not there yet; throws only on an unsafe file.
export function readCandidateFile(root, name, location = 'candidates') {
  const file = candidatePath(root, name, location);
  let fd;
  try {
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.uid !== process.getuid() || (initial.mode & 0o077) || initial.nlink !== 1) {
      return { ok: false, reason: 'candidate_unsafe_file' };
    }
    if (initial.size > CANDIDATE_SIZE_LIMIT) return { ok: false, reason: 'candidate_too_large' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.ino !== initial.ino || opened.dev !== initial.dev) return { ok: false, reason: 'candidate_unsafe_file' };
    const raw = fs.readFileSync(fd, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { ok: false, reason: 'candidate_invalid_json' }; }
    return {
      ok: true, reason: null, candidate: parsed,
      contentHash: crypto.createHash('sha256').update(raw).digest('hex'),
      observedAt: Math.min(opened.mtimeMs, Date.now()),
    };
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'candidate_missing' : 'candidate_unreadable' };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Projects a candidate document onto readiness facts. Field aliases are accepted because the
// existing writers predate this mechanism; anything unrecognised is dropped rather than guessed.
export function candidateReadiness(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'candidate_not_an_object' };
  const sha = first(candidate.sha, candidate.headSha, candidate.commit, candidate.revision);
  const checkpointDigest = first(candidate.checkpointDigest, candidate.checkpointHash);
  const digest = first(candidate.digest, candidate.resultHash, candidate.artifactDigest, checkpointDigest);
  if (!text(sha) || !FULL_SHA.test(sha.trim())) return { ok: false, reason: 'candidate_sha_missing' };
  if (!text(digest) || !DIGEST.test(digest.trim())) return { ok: false, reason: 'candidate_digest_missing' };
  const declared = text(candidate.digestKind) ? candidate.digestKind.trim() : null;
  const digestKind = DIGEST_KINDS.has(declared) ? declared
    : text(candidate.resultHash) ? 'result'
    : text(candidate.artifactDigest) ? 'artifact'
    : checkpointDigest && digest.trim() === checkpointDigest.trim() ? 'checkpoint' : 'result';
  return {
    ok: true, reason: null,
    sha: sha.trim(), digest: digest.trim(), digestKind,
    checkpointDigest: text(checkpointDigest) && DIGEST.test(checkpointDigest.trim()) ? checkpointDigest.trim() : null,
    evidenceRef: first(candidate.evidenceRef, candidate.evidence, candidate.artifact, candidate.report),
    owner: first(candidate.owner, candidate.worker),
    coordinator: first(candidate.coordinator, candidate.reviewer, candidate.awaiting),
    // Retained as an untrusted claim. Elapsed review time uses the observed file time.
    claimedAt: first(candidate.writtenAt, candidate.at, candidate.generatedAt, candidate.finishedAt),
  };
}

// Registers one candidate file for one subject, inside an open transaction.
export function attachCandidateSource(subject, { file, location = 'candidates', owner, registeredBy, now = Date.now() }) {
  const name = candidateFileName(file);
  const where = candidateLocation(location);
  // Validate the resolved path at registration time, so an unusable registration fails now.
  candidatePath('/', name, where);
  subject.record.candidateSource = {
    file: name, location: where, owner: owner ?? subject.owner ?? null,
    registeredBy: registeredBy ?? owner ?? null, registeredAt: new Date(now).toISOString(),
  };
  return structuredClone(subject.record.candidateSource);
}

// Ingests every registered candidate into `record.review`. Idempotent: an unchanged file is
// read and skipped, so repeated reconciliation neither rewrites state nor re-notifies.
export function ingestCandidates(root, subjects, { now = Date.now() } = {}) {
  const outcomes = [];
  for (const subject of subjects) {
    const source = subject.record?.candidateSource;
    if (!source || !text(source.file)) continue;
    let read;
    try { read = readCandidateFile(root, source.file, source.location); }
    catch { outcomes.push({ id: subject.id, ingested: false, reason: 'candidate_registration_invalid' }); continue; }
    if (!read.ok) { outcomes.push({ id: subject.id, ingested: false, reason: read.reason }); continue; }
    const facts = candidateReadiness(read.candidate);
    if (!facts.ok) { outcomes.push({ id: subject.id, ingested: false, reason: facts.reason }); continue; }
    // Ownership is checked against the record, never taken from the file alone.
    const owner = subject.owner ?? source.owner ?? null;
    if (text(facts.owner) && text(owner) && facts.owner !== owner) {
      outcomes.push({ id: subject.id, ingested: false, reason: 'candidate_owner_mismatch' });
      continue;
    }
    const existing = subject.record.review;
    if (existing?.source === 'candidate_file' && existing.candidateHash === read.contentHash) {
      outcomes.push({ id: subject.id, ingested: false, reason: 'candidate_unchanged' });
      continue;
    }
    const revision = subject.kind === 'job'
      ? (subject.record.revision ?? 0) + 1
      : (subject.record.reviewSeq = (subject.record.reviewSeq ?? 0) + 1);
    subject.record.review = {
      source: 'candidate_file', revision,
      sha: facts.sha, digest: facts.digest, digestKind: facts.digestKind,
      checkpointDigest: facts.checkpointDigest,
      evidenceRef: facts.evidenceRef ?? `queue:candidate:${source.location ?? 'candidates'}/${source.file}`,
      owner: owner ?? facts.owner ?? null,
      coordinator: facts.coordinator ?? subject.coordinator ?? null,
      at: new Date(Math.min(read.observedAt, now)).toISOString(),
      claimedAt: facts.claimedAt, claimTrusted: false,
      candidateFile: source.file, candidateLocation: source.location ?? 'candidates', candidateHash: read.contentHash,
      launchId: subject.launchId ?? null,
    };
    subject.review = subject.record.review;
    subject.revision = revision;
    outcomes.push({ id: subject.id, ingested: true, reason: null });
  }
  return outcomes;
}
