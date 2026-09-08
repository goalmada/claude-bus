import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export function scopedPath(root, relative, { missing = false } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.') || p === 'node_modules')) throw new Error('Path outside permitted source scope');
  let current = fs.realpathSync(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT' && missing) continue; throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('Linked files are not allowed');
  }
  return current;
}
export function validateScope(root, scope) {
  if (!scope || !Array.isArray(scope.read) || !Array.isArray(scope.edit) || !Array.isArray(scope.tests) || !scope.edit.length || !scope.tests.length || scope.edit.length > 20) throw new Error('Writable task requires read/edit/test scope');
  for (const relative of [...scope.read, ...scope.edit, ...scope.tests]) scopedPath(root, relative, { missing: true });
  if (scope.tests.some(p => !/^test\/.+\.test\.js$/.test(p))) throw new Error('Only explicit Node test files are supported');
  return { read: [...new Set([...scope.read, ...scope.edit, ...scope.tests])].sort(), edit: [...new Set(scope.edit)].sort(), tests: [...new Set(scope.tests)].sort() };
}
export function checkpoint(root, scope) {
  const files = {};
  for (const relative of scope.edit) {
    const file = scopedPath(root, relative, { missing: true });
    files[relative] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (files[relative] && Buffer.byteLength(files[relative]) > 512 * 1024) throw new Error('Edited file exceeds cap');
  }
  return { files, hash: hash(JSON.stringify(files)) };
}
export function assertDiffScope(root, scope, { outputs = [] } = {}) {
  if (outputs.some(dir => !['build', 'dist', '.next'].includes(dir))) throw new Error('Unsupported output directory');
  const changed = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const entry of changed) {
    const relative = entry.slice(3);
    const generated = entry.startsWith('?? ') && outputs.some(dir => relative.startsWith(dir + '/'));
    if (entry.includes(' -> ') || (!scope.edit.includes(relative) && !generated)) throw new Error('Changes outside assigned scope');
    scopedPath(root, relative, { missing: true });
  }
}
