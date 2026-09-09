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
export function artifactDrift(bound, observation) {
  if (!bound || !observation) return null;
  if (!observation.available) return observation.reason === 'no_assigned_worktree' ? null : `artifact_unobservable:${observation.reason}`;
  if (bound.sha && observation.headSha && bound.sha !== observation.headSha) return 'head_moved';
  // Scoped project work is bound to its checkpoint, so uncommitted edits inside the assigned
  // scope are expected: the checkpoint digest, not the dirty flag, is the honest comparison.
  const checkpointBinding = bound.digestKind === 'checkpoint' ? bound.digest : bound.checkpointDigest;
  if (checkpointBinding) {
    return observation.checkpointHash && observation.checkpointHash !== checkpointBinding ? 'checkpoint_changed' : null;
  }
  if (observation.dirty) return 'worktree_modified';
  return null;
}
