// Storage primitives for claude-bus.
//
// State lives under ~/.claude-bus/
//   inbox/<name>.jsonl   — append-only log of messages delivered to <name>
//   cursor/<name>.txt    — byte offset into inbox/<name>.jsonl of the last
//                          message this session has read
//   active/<ppid>.txt    — identity claimed by the Claude Code session whose
//                          PID is <ppid>. Used by the GUI app where the
//                          CLAUDE_BUS_NAME env var can't be set per session.
//
// Writers only ever append to inbox files. Readers only ever advance their
// own cursor. No locks, no rewrites, no races.

import { promises as fs } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = path.join(os.homedir(), ".claude-bus");
const INBOX_DIR = path.join(ROOT, "inbox");
const CURSOR_DIR = path.join(ROOT, "cursor");
const ACTIVE_DIR = path.join(ROOT, "active");

for (const dir of [ROOT, INBOX_DIR, CURSOR_DIR, ACTIVE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const MAX_BODY_BYTES = 8 * 1024;

const nameRe = /^[a-zA-Z0-9_-]{1,64}$/;
function assertName(name, label) {
  if (typeof name !== "string" || !nameRe.test(name)) {
    throw new Error(
      `invalid ${label} "${name}": must be 1-64 chars, [a-zA-Z0-9_-] only`
    );
  }
}

function inboxPath(name) {
  return path.join(INBOX_DIR, `${name}.jsonl`);
}

function cursorPath(name) {
  return path.join(CURSOR_DIR, `${name}.txt`);
}

export function newMessageId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export async function appendMessage({ from, to, kind, reply_to, body }) {
  assertName(from, "from");
  assertName(to, "to");
  if (typeof kind !== "string" || kind.length === 0 || kind.length > 32) {
    throw new Error(`invalid kind "${kind}"`);
  }
  if (reply_to != null && typeof reply_to !== "string") {
    throw new Error("reply_to must be a string or null");
  }
  if (typeof body !== "string") {
    throw new Error("body must be a string; stringify structured data first");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error(
      `body exceeds ${MAX_BODY_BYTES} bytes. Write the payload to a file and ` +
        `send the path plus a short summary instead.`
    );
  }

  const msg = {
    id: newMessageId(),
    from,
    to,
    kind,
    reply_to: reply_to ?? null,
    body,
    created_at: new Date().toISOString(),
  };

  const line = JSON.stringify(msg) + "\n";
  await fs.appendFile(inboxPath(to), line, "utf8");
  return msg;
}

async function readCursor(name) {
  try {
    const raw = await fs.readFile(cursorPath(name), "utf8");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

async function writeCursor(name, offset) {
  await fs.writeFile(cursorPath(name), String(offset), "utf8");
}

export async function readInbox(name, { peek = false } = {}) {
  assertName(name, "name");
  const file = inboxPath(name);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return { messages: [], cursor: 0 };
    throw err;
  }

  const cursor = await readCursor(name);
  if (cursor >= stat.size) return { messages: [], cursor };

  const fh = await fs.open(file, "r");
  try {
    const len = stat.size - cursor;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, cursor);
    const text = buf.toString("utf8");
    const messages = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { error: "corrupt line", raw: l };
        }
      });
    if (!peek) await writeCursor(name, stat.size);
    return { messages, cursor: stat.size };
  } finally {
    await fh.close();
  }
}

export async function listPeers() {
  let entries;
  try {
    entries = await fs.readdir(INBOX_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

// Rich peer listing: every name that has either claimed an identity or
// received mail. For each, indicates whether at least one Claude Code
// process holding that name is still alive, and how many messages are
// currently queued in its inbox.
export async function listPeerInfo() {
  pruneStaleActive();

  const peers = new Map(); // name -> { alive, has_inbox }

  // Names with inboxes (received mail at some point).
  try {
    const entries = await fs.readdir(INBOX_DIR);
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const name = f.slice(0, -".jsonl".length);
      peers.set(name, { alive: false, has_inbox: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  // Names with active claims (somebody is currently a session by this name).
  let activeFiles = [];
  try {
    activeFiles = await fs.readdir(ACTIVE_DIR);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const f of activeFiles) {
    if (!f.endsWith(".txt")) continue;
    const pid = parseInt(f.slice(0, -4), 10);
    if (!Number.isFinite(pid)) continue;

    let name;
    try {
      name = (await fs.readFile(path.join(ACTIVE_DIR, f), "utf8")).trim();
    } catch {
      continue;
    }
    if (!name) continue;

    let alive = true;
    try { process.kill(pid, 0); }
    catch (err) { alive = err.code !== "ESRCH"; }

    const prev = peers.get(name) || { alive: false, has_inbox: false };
    peers.set(name, { ...prev, alive: prev.alive || alive });
  }

  // Attach unread counts.
  const result = [];
  for (const [name, info] of peers.entries()) {
    let unread = 0;
    try { unread = await unreadCount(name); } catch {}
    result.push({ name, alive: info.alive, has_inbox: info.has_inbox, unread });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function unreadCount(name) {
  const file = inboxPath(name);
  try {
    const [stat, cursor] = await Promise.all([fs.stat(file), readCursor(name)]);
    if (cursor >= stat.size) return 0;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  // Count lines between cursor and EOF.
  const stat = await fs.stat(file);
  const cursor = await readCursor(name);
  const fh = await fs.open(file, "r");
  try {
    const len = stat.size - cursor;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, cursor);
    let count = 0;
    for (const b of buf) if (b === 0x0a) count++;
    return count;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Active-identity registry, keyed by Claude Code session PID.
// ---------------------------------------------------------------------------
// In a terminal you set CLAUDE_BUS_NAME before launching `claude`. In the
// Mac app there is no per-window shell, so the session calls bus_claim()
// once at startup and we persist its name in active/<ppid>.txt. The hook
// reads the same file so it can render the unread-mail reminder.

function activePath(ppid) {
  return path.join(ACTIVE_DIR, `${ppid}.txt`);
}

export function setActiveIdentity(ppid, name) {
  assertName(name, "name");
  if (!Number.isInteger(ppid) || ppid <= 0) {
    throw new Error(`invalid ppid: ${ppid}`);
  }
  writeFileSync(activePath(ppid), name, "utf8");
}

export function getActiveIdentity(ppid) {
  try {
    return readFileSync(activePath(ppid), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function pruneStaleActive() {
  let entries;
  try {
    entries = readdirSync(ACTIVE_DIR);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".txt")) continue;
    const pid = parseInt(f.slice(0, -4), 10);
    if (!Number.isFinite(pid)) continue;
    let alive = true;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe
    } catch (err) {
      // ESRCH = no such process; EPERM = exists but not ours, treat as alive
      alive = err.code !== "ESRCH";
    }
    if (!alive) {
      try { unlinkSync(path.join(ACTIVE_DIR, f)); } catch {}
    }
  }
}

export const _paths = {
  ROOT, INBOX_DIR, CURSOR_DIR, ACTIVE_DIR,
  inboxPath, cursorPath, activePath,
};
