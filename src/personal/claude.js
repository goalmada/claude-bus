import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Personal use only. No token lookup, inherited OAuth, key helper, provider or paid fallback.
export function nativeClaude(root, inspect = (args, env) => JSON.parse(execFileSync('claude', args, {
  env, encoding: 'utf8', timeout: 5000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'],
}))) {
  return {
    async prepare() {
      const gatePath = path.join(root, 'native-max-verification.json');
      if (!fs.existsSync(gatePath)) throw new Error('Real launches disabled until native Max verification');
      const st = fs.lstatSync(gatePath);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Verification must be a private regular file');
      const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      const age = Date.now() - Date.parse(gate.checkedAt);
      if (gate.enabled !== true || gate.plan !== 'max' || gate.extraUsageEnabled !== false || gate.available !== true ||
          !Number.isFinite(age) || age < 0 || age > 3600000 || !gate.evidence || !/^[0-9a-f-]{36}$/i.test(gate.organizationId ?? '')) {
        throw new Error('Fresh native Max /status and /usage verification required; no extra usage');
      }
      const env = {};
      for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const settings = JSON.stringify({ forceLoginMethod: 'claudeai', forceLoginOrgUUID: gate.organizationId });
      const base = ['--safe-mode', '--restricted', '--settings', settings];
      const status = inspect([...base, 'auth', 'status'], env);
      // Fail closed on unknown future auth schemas. These are native stored-login labels.
      if (!status.loggedIn || !['claude.ai', 'claudeAi', 'oauth'].includes(status.authMethod) || status.apiProvider !== 'firstParty') {
        throw new Error('Native subscription login is unavailable or unrecognized');
      }
      return {
        command: 'claude', env,
        args: [...base, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--permission-mode', 'dontAsk', '--no-session-persistence', '--no-chrome',
          '-p', '--output-format', 'stream-json', '--verbose'],
      };
    },
  };
}
