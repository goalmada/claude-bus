// Exercise the two deterministic orders that exposed the registry collision,
// plus normal concurrent startup. Each run owns a fresh temporary HOME.
import { spawnSync } from "node:child_process";
for (const order of ["tester-first", "auditor-first", "parallel"]) {
  console.log(`Session startup: ${order}`);
  const result = spawnSync(process.execPath, ["test/mcp_roundtrip.js"], {
    env: { ...process.env, CLAUDE_BUS_TEST_SESSION_ORDER: order },
    stdio: "inherit",
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
