/*
 * MCP stdio<->SSE bridge (inline implementation).
 *
 * Lifecycle: a single child process per plugin is lazily spawned the first
 * time someone asks for it. Frames coming back from the child are
 * newline-delimited JSON-RPC; we relay each one to every attached SSE
 * subscriber. Inbound client traffic arrives via HTTP POST and is forwarded
 * to the child's stdin.
 */

const { spawn: spawnChild } = require("child_process");
const fsModule = require("fs");
const pathModule = require("path");
const { randomUUID } = require("crypto");
const { LOCAL_STDIO_PLUGINS } = require("@/shared/constants/coworkPlugins");
const { DATA_DIR } = require("@/lib/dataDir");

// ---------------------------------------------------------------------------
// Constants & module-level config
// ---------------------------------------------------------------------------

const CUSTOM_FILE = pathModule.join(DATA_DIR, "mcp", "customPlugins.json");

// IMPORTANT: globalThis key consumed by sibling modules — do not rename.
const G_KEY = "__LinaRouterMcpBridges";
const CUSTOM_GLOBAL_KEY = "__LinaRouterCustomPlugins";

const MAX_TEXT_CHARS = 50000;
const COLLAPSE_THRESHOLD = 30;
const COLLAPSE_KEEP_HEAD = 10;
const COLLAPSE_KEEP_TAIL = 5;

const ROLE_LINE_RX = /^(\s*)-\s*([a-zA-Z]+)\b/;
const NOISE_GENERIC_RX = /^\s*-\s*generic:?\s*$/gm;
const NOISE_EMPTY_TEXT_RX = /^\s*-\s*text:\s*""\s*$/gm;

// ---------------------------------------------------------------------------
// Global store accessors (lazy-init the maps on globalThis)
// ---------------------------------------------------------------------------

function getStore() {
  const existing = globalThis[G_KEY];
  if (existing) return existing;
  const fresh = new Map();
  globalThis[G_KEY] = fresh;
  return fresh;
}

function getCustomStore() {
  const existing = globalThis[CUSTOM_GLOBAL_KEY];
  if (existing) return existing;
  const fresh = new Map();
  globalThis[CUSTOM_GLOBAL_KEY] = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

function registerCustomPlugin(def) {
  getCustomStore().set(def.name, def);
}

function loadCustomFromDisk(name) {
  // Custom plugins live on disk so they survive a process restart.
  try {
    const raw = fsModule.readFileSync(CUSTOM_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const match = parsed.find((p) => p.name === name && p.command);
    if (!match) return null;
    getCustomStore().set(match.name, match);
    return match;
  } catch {
    // Missing/corrupt file is fine — caller will handle a null result.
    return null;
  }
}

function findPlugin(name) {
  const inMemory = getCustomStore().get(name)
    || LOCAL_STDIO_PLUGINS.find((p) => p.name === name);
  if (inMemory) return inMemory;
  return loadCustomFromDisk(name);
}

// ---------------------------------------------------------------------------
// Repetition collapse / noise stripping for SSE text payloads
// ---------------------------------------------------------------------------

function locateHeadCutoff(lines, fromIdx, indent, role, keepN) {
  let seen = 0;
  for (let k = fromIdx; k < lines.length; k++) {
    const hit = lines[k].match(ROLE_LINE_RX);
    if (!hit) continue;
    if (hit[1] !== indent || hit[2] !== role) continue;
    seen++;
    if (seen > keepN) return k;
  }
  return lines.length;
}

function locateTailStart(lines, untilIdx, indent, role, keepN) {
  const hits = [];
  for (let k = 0; k < untilIdx; k++) {
    const hit = lines[k].match(ROLE_LINE_RX);
    if (hit && hit[1] === indent && hit[2] === role) hits.push(k);
  }
  if (hits.length <= keepN) return untilIdx;
  return hits[hits.length - keepN];
}

/*
 * Walk the line array. When we encounter a "- role" entry we look ahead to
 * find the run of consecutive siblings sharing the same indent + role
 * (children belonging to those siblings count as part of the run). If the
 * run is large enough we keep COLLAPSE_KEEP_HEAD entries up front and
 * COLLAPSE_KEEP_TAIL entries at the end, replacing the middle with a
 * placeholder line.
 */
function collapseRepeated(text) {
  const lines = text.split("\n");
  const result = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const startLine = lines[cursor];
    const header = startLine.match(ROLE_LINE_RX);

    if (!header) {
      result.push(startLine);
      cursor++;
      continue;
    }

    const indent = header[1];
    const role = header[2];
    let probe = cursor;

    while (probe < lines.length) {
      const ln = lines[probe];
      const ph = ln.match(ROLE_LINE_RX);
      const isSibling = ph && ph[1] === indent && ph[2] === role;
      const isChildOfSibling = ln.startsWith(`${indent} `) || ln.startsWith(`${indent}\t`);
      if (isSibling || isChildOfSibling) {
        probe++;
        continue;
      }
      break;
    }

    const span = probe - cursor;

    if (span < COLLAPSE_THRESHOLD) {
      for (let k = cursor; k < probe; k++) result.push(lines[k]);
      cursor = probe;
      continue;
    }

    const headCut = locateHeadCutoff(lines, cursor, indent, role, COLLAPSE_KEEP_HEAD);
    const tailCut = locateTailStart(lines, probe, indent, role, COLLAPSE_KEEP_TAIL);
    const omitted = span - COLLAPSE_KEEP_HEAD - COLLAPSE_KEEP_TAIL;

    for (let k = cursor; k < headCut; k++) result.push(lines[k]);
    result.push(`${indent}... [${omitted} similar "${role}" items omitted by LINA Router bridge]`);
    for (let k = tailCut; k < probe; k++) result.push(lines[k]);

    cursor = probe;
  }

  return result.join("\n");
}

/*
 * Public-ish helper used by filterFrame. Cheap fast-path for short text
 * (the common case), then noise stripping, then collapse, then a hard
 * character ceiling. The [ref=eXX] anchor convention from the upstream
 * accessibility snapshots is left intact.
 */
function smartFilterText(text) {
  if (typeof text !== "string") return text;
  if (text.length < 2000) return text;

  let working = text
    .replace(NOISE_GENERIC_RX, "")
    .replace(NOISE_EMPTY_TEXT_RX, "");

  working = collapseRepeated(working);

  if (working.length > MAX_TEXT_CHARS) {
    const sliced = working.slice(0, MAX_TEXT_CHARS - 300);
    const dropped = text.length - sliced.length;
    working = `${sliced}\n\n... [truncated ${dropped} chars by LINA Router bridge. Page is large; ask user to scroll/navigate to a specific section, or click an element with the refs shown above]`;
  }

  return working;
}

/*
 * Only result.content[].text segments get rewritten. If nothing changed we
 * return the original buffer to avoid a JSON re-serialization round-trip.
 * Anything we can't parse is passed through unmodified.
 */
function filterFrame(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }

  const content = msg && msg.result && msg.result.content;
  if (!Array.isArray(content)) return line;

  const changed = content.reduce((acc, item) => {
    if (!item || item.type !== "text" || typeof item.text !== "string") return acc;
    const next = smartFilterText(item.text);
    if (next === item.text) return acc;
    item.text = next;
    return true;
  }, false);

  return changed ? JSON.stringify(msg) : line;
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function isEntryAlive(entry) {
  if (!entry || !entry.proc) return false;
  if (entry.proc.killed) return false;
  return entry.proc.exitCode === null;
}

function attachStdoutPipe(entry, name) {
  // The child emits newline-delimited JSON-RPC. We accumulate partial
  // chunks in entry.buffer and flush whole frames as they complete.
  entry.proc.stdout.on("data", (chunk) => {
    entry.buffer += chunk.toString("utf8");
    let nlAt;
    while ((nlAt = entry.buffer.indexOf("\n")) >= 0) {
      const raw = entry.buffer.slice(0, nlAt).trim();
      entry.buffer = entry.buffer.slice(nlAt + 1);
      if (!raw) continue;
      const payload = filterFrame(raw);
      for (const send of entry.sessions.values()) {
        try {
          send(`event: message\ndata: ${payload}\n\n`);
        } catch {
          // Swallow — a single broken pipe shouldn't poison the fan-out.
        }
      }
    }
  });

  entry.proc.stderr.on("data", (d) => {
    console.log(`[mcp:${name}]`, d.toString().trim());
  });

  entry.proc.on("exit", (code) => {
    console.log(`[mcp:${name}] exited`, code);
    getStore().delete(name);
  });
}

function getOrSpawn(name) {
  const store = getStore();
  const cached = store.get(name);
  if (isEntryAlive(cached)) return cached;

  const plugin = findPlugin(name);
  if (!plugin) throw new Error(`Unknown local plugin: ${name}`);

  const proc = spawnChild(plugin.command, plugin.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const entry = {
    proc,
    sessions: new Map(),
    buffer: "",
  };
  store.set(name, entry);
  attachStdoutPipe(entry, name);
  return entry;
}

function isRunning(name) {
  return isEntryAlive(getStore().get(name));
}

// ---------------------------------------------------------------------------
// Session + message plumbing (consumed by the /api/mcp/[plugin]/* routes)
// ---------------------------------------------------------------------------

function registerSession(name, sendFn) {
  const entry = getOrSpawn(name);
  const sid = randomUUID();
  entry.sessions.set(sid, sendFn);
  return sid;
}

function unregisterSession(name, sid) {
  const entry = getStore().get(name);
  if (!entry) return;
  entry.sessions.delete(sid);
}

function sendToChild(name, jsonRpc) {
  const entry = getStore().get(name);
  const stdin = entry && entry.proc && entry.proc.stdin;
  if (!stdin || !stdin.writable) throw new Error(`Bridge not running: ${name}`);
  stdin.write(`${JSON.stringify(jsonRpc)}\n`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getOrSpawn,
  registerSession,
  unregisterSession,
  sendToChild,
  isRunning,
  findPlugin,
  registerCustomPlugin,
};
