import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const mode of ["SIGTERM", "disconnect"]) {
  test(`session host cleans up its server on ${mode}`, { timeout: 5000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "bus-host-test-"));
    const host = spawn(process.execPath, ["test/fixtures/session-host.js"], {
      env: { HOME: home, PATH: process.env.PATH, CLAUDE_BUS_NAME: "fixture" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const closed = new Promise((resolve) => host.once("exit", resolve));
    try {
      const pid = await new Promise((resolve) => host.once("message", (m) => resolve(m.serverPid)));
      process.kill(pid, 0);
      if (mode === "SIGTERM") host.kill("SIGTERM");
      else host.disconnect();
      await closed;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      host.kill("SIGTERM");
      await closed;
      host.stdin.destroy();
      host.stdout.destroy();
      host.stderr.destroy();
      await rm(home, { recursive: true, force: true });
    }
  });
}
