import fs from 'node:fs';
import path from 'node:path';
import { evaluateNativeGate } from './native-gate.js';

// Return fixed diagnostics only. The validated record is for the native launcher, not logs.
export function inspectNativeGate(root, now = Date.now()) {
  const file = path.join(root, 'native-max-verification.json');
  let fd;
  try {
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.uid !== process.getuid() || (initial.mode & 0o077) || initial.nlink !== 1) return { ok:false, reason:'native_gate_unsafe_file' };
    if (initial.size > 65536) return { ok:false, reason:'native_gate_invalid' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.ino !== initial.ino || opened.dev !== initial.dev) return { ok:false, reason:'native_gate_unsafe_file' };
    let gate;
    try { gate = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { return { ok:false, reason:'native_gate_invalid' }; }
    const decision = evaluateNativeGate(gate, now);
    return decision.ok ? { ...decision, gate } : decision;
  } catch (error) {
    return { ok:false, reason:error.code === 'ENOENT' ? 'native_gate_missing' : 'native_gate_unreadable' };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
