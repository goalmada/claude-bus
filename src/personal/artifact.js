import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkpoint } from './workspace.js';

// Bounded, read-only observation of exactly the worktree assigned to a coordination subject.
// No other path is read, nothing is written, and no command supplied by a task is executed.
// This is what lets reconciliation detect that an approved artifact changed even when the
// worker never republishes its readiness record.

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();

export function observeSubject(subject, { now = Date.now() } = {}) {
  const observedAt = new Date(now).toISOString();
  const worktree = subject?.worktree;
  if (typeof worktree !== 'string' || !worktree.length) return { available: false, reason: 'no_assigned_worktree', observedAt };
  try {
    const real = fs.realpathSync(worktree);
    if (!fs.statSync(real).isDirectory()) return { available: false, reason: 'worktree_unreadable', observedAt };
    const headSha = git(real, 'rev-parse', 'HEAD');
    const dirty = git(real, 'status', '--porcelain', '--untracked-files=all').length > 0;
    let checkpointHash = null;
    if (subject.scope) {
      try { checkpointHash = checkpoint(real, subject.scope).hash; }
      catch { return { available: false, reason: 'checkpoint_unreadable', observedAt, headSha, dirty }; }
    }
    return { available: true, reason: null, headSha, dirty, checkpointHash, observedAt };
  } catch { return { available: false, reason: 'worktree_unreadable', observedAt }; }
}

// One observation per worktree and scope per reconciliation pass.
export function memoizedObserver(observe = observeSubject) {
  const cache = new Map();
  return (subject, options) => {
    const key = `${subject?.worktree ?? ''}|${subject?.scope ? JSON.stringify(subject.scope) : ''}`;
    if (!cache.has(key)) cache.set(key, observe(subject, options));
    return cache.get(key);
  };
}

// Compares the durable binding (a readiness record or a coordinator approval) with what the
// filesystem actually shows now. An assigned worktree that cannot be read is drift, not
// silence: uncertainty invalidates an approval rather than preserving it.
// `requireEvidence` is set wherever a decision depends on the artifact still being provable,
// which is every approval, deployment and verification. In that mode the absence of evidence
// is drift: an unreadable worktree, no assigned worktree at all, or a checkpoint binding whose
// digest cannot be recomputed all invalidate rather than silently pass.
export function artifactDrift(bound, observation, { requireEvidence = false } = {}) {
  if (!bound) return null;
  if (!observation) return requireEvidence ? 'artifact_evidence_missing:no_observation' : null;
  if (!observation.available) {
    if (observation.reason === 'no_assigned_worktree') return requireEvidence ? 'artifact_evidence_missing:no_assigned_worktree' : null;
    return `artifact_unobservable:${observation.reason}`;
  }
  if (bound.sha && !observation.headSha) return requireEvidence ? 'artifact_evidence_missing:head_unobservable' : null;
  if (bound.sha && observation.headSha && bound.sha !== observation.headSha) return 'head_moved';
  // Scoped project work is bound to its checkpoint, so uncommitted edits inside the assigned
  // scope are expected: the checkpoint digest, not the dirty flag, is the honest comparison.
  const checkpointBinding = bound.digestKind === 'checkpoint' ? bound.digest : bound.checkpointDigest;
  if (checkpointBinding) {
    if (!observation.checkpointHash) return 'checkpoint_unobservable';
    return observation.checkpointHash !== checkpointBinding ? 'checkpoint_changed' : null;
  }
  if (observation.dirty) return 'worktree_modified';
  return null;
}
