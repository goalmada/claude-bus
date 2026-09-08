// Model one Claude session parent for one MCP server. Inherited transport
// descriptors keep JSON-RPC unchanged; IPC is only for parent lifecycle.
import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["src/server.js"], { stdio: "inherit" });
let stopping = false;
let killTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  killTimer = setTimeout(() => server.kill("SIGKILL"), 1000);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
server.on("close", (code) => {
  clearTimeout(killTimer);
  if (process.connected) process.disconnect();
  process.exitCode = stopping ? 0 : (code ?? 1);
});
// Publish readiness only after disconnect and signal handlers are installed.
process.send?.({ serverPid: server.pid });
