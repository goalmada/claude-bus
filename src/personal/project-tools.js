import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { scopedPath, hash } from './workspace.js';

export function testProfile(worktree, temporary) {
  const literal = value => JSON.stringify(value);
  const runtime = fs.realpathSync(path.dirname(process.execPath));
  return `(version 1)
(deny default)
(allow process-exec (literal ${literal(fs.realpathSync(process.execPath))}))
(allow process-info* sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/opt") (literal "/private") (literal "/private/var"))
(allow file-read* (subpath ${literal(worktree)}) (subpath ${literal(temporary)}) (subpath ${literal(runtime)}) (subpath "/usr") (subpath "/System") (subpath "/Library/Apple") (subpath "/opt/homebrew") (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/urandom"))
(deny file-read-data (subpath ${literal(path.join(worktree, '.git'))}) (subpath ${literal(path.join(worktree, '.claude'))}) (regex #"/\\.env([^/]*)(/|$)"))
(allow file-write* (subpath ${literal(temporary)}) (literal "/dev/null"))`;
}

export function projectTools(job, privateRoot) {
  const scope = job.scope;
  const auditPath = path.join(privateRoot, `${job.id}-tools.jsonl`);
  const audit = record => fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), taskId: job.id, launchId: job.launchId, ...record }) + '\n', { mode: 0o600 });
  const check = (relative, edit = false) => {
    if (!(edit ? scope.edit : scope.read).includes(relative)) throw new Error('File not assigned to this task');
    return scopedPath(job.worktree, relative, { missing: edit });
  };
  return {
    read_file({ file }) {
      const content = fs.readFileSync(check(file), 'utf8');
      if (Buffer.byteLength(content) > 128 * 1024) throw new Error('Read exceeds cap');
      audit({ tool: 'read_file', file }); return { content, hash: hash(content) };
    },
    write_file({ file, content, expectedHash }) {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) throw new Error('Write exceeds cap');
      const target = check(file, true);
      const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if ((previous === null ? null : hash(previous)) !== expectedHash) throw new Error('File changed since read; do not overwrite');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Recheck parent components after creation; no symlinks or hard links accepted.
      check(file, true);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o644);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      audit({ tool: 'write_file', file, before: expectedHash, after: hash(content) });
      return { file, hash: hash(content) };
    },
    async run_tests() {
      if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('Required test sandbox unavailable; no unsandboxed fallback');
      for (const file of scope.tests) check(file);
      const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'personal-tests-')));
      const env = { PATH: '/usr/bin:/bin', TMPDIR: temporary, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1' };
      let output = '', failed = false;
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn('/usr/bin/sandbox-exec', ['-p', testProfile(job.worktree, temporary), process.execPath, '--test', '--experimental-test-isolation=none', ...scope.tests], { cwd: job.worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
          const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 30000);
          child.on('error', reject);
          for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 128 * 1024) { failed = true; child.kill('SIGKILL'); } });
          child.on('close', code => { clearTimeout(timer); resolve({ code, output: output.slice(0, 128 * 1024), capped: failed }); });
        });
        audit({ tool: 'run_tests', code: result.code, capped: result.capped, outputHash: hash(result.output) });
        return result;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    },
  };
}
