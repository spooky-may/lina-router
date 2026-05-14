/**
 * Lightweight, in-process event telemetry for LINA Router.
 *
 * Records discrete domain events (provider switches, fallback triggers, RTK
 * compression hits, OAuth refresh outcomes) and exposes them via a sliding
 * window aggregator. Designed to be cheap enough to call on every request
 * without coordinating with the SQLite layer.
 *
 * All state lives in process memory. The dashboard reads via the snapshot API;
 * external observability tools should consume the JSONL drain file instead.
 */

import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";

const WINDOW_MS = 5 * 60 * 1000;        // 5 minutes
const MAX_EVENTS_IN_RING = 5_000;
const DRAIN_INTERVAL_MS = 30_000;
const DRAIN_FILE_MAX_BYTES = 4 * 1024 * 1024;

const KIND = Object.freeze({
  PROVIDER_SWITCH: "provider.switch",
  FALLBACK_TRIGGERED: "provider.fallback",
  RATE_LIMIT_HIT: "provider.rateLimit",
  RTK_COMPRESSED: "rtk.compressed",
  RTK_BYPASSED: "rtk.bypassed",
  OAUTH_REFRESH_OK: "oauth.refresh.ok",
  OAUTH_REFRESH_FAIL: "oauth.refresh.fail",
  REQUEST_OK: "request.ok",
  REQUEST_FAIL: "request.fail",
  MCP_BRIDGE_OPEN: "mcp.bridge.open",
  MCP_BRIDGE_CLOSE: "mcp.bridge.close",
});

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.cursor = 0;
    this.length = 0;
  }

  push(item) {
    this.buffer[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.length < this.capacity) this.length += 1;
  }

  *items() {
    if (this.length === 0) return;
    const start = (this.cursor - this.length + this.capacity) % this.capacity;
    for (let i = 0; i < this.length; i += 1) {
      yield this.buffer[(start + i) % this.capacity];
    }
  }

  clear() {
    this.cursor = 0;
    this.length = 0;
    this.buffer.fill(undefined);
  }
}

class EventTelemetry extends EventEmitter {
  constructor({ drainPath } = {}) {
    super();
    this.ring = new RingBuffer(MAX_EVENTS_IN_RING);
    this.counters = new Map();          // kind → total count since boot
    this.lastSeen = new Map();          // kind → most recent timestamp
    this.drainPath = drainPath || null;
    this._drainTimer = null;
    this._pendingDrain = [];
  }

  record(kind, payload = {}) {
    if (!kind) return;
    const event = {
      kind,
      ts: Date.now(),
      ...payload,
    };

    this.ring.push(event);
    this.counters.set(kind, (this.counters.get(kind) || 0) + 1);
    this.lastSeen.set(kind, event.ts);

    if (this.drainPath) this._pendingDrain.push(event);

    this.emit("event", event);
    this.emit(kind, event);
  }

  // Count of events of a given kind within the trailing window.
  windowCount(kind, windowMs = WINDOW_MS) {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const ev of this.ring.items()) {
      if (ev.kind === kind && ev.ts >= cutoff) n += 1;
    }
    return n;
  }

  // Bucketed histogram for a numeric field on a given event kind.
  histogram(kind, field, buckets) {
    const sortedBuckets = [...buckets].sort((a, b) => a - b);
    const dist = new Array(sortedBuckets.length + 1).fill(0);
    for (const ev of this.ring.items()) {
      if (ev.kind !== kind) continue;
      const value = ev[field];
      if (typeof value !== "number") continue;
      let placed = false;
      for (let i = 0; i < sortedBuckets.length; i += 1) {
        if (value <= sortedBuckets[i]) {
          dist[i] += 1;
          placed = true;
          break;
        }
      }
      if (!placed) dist[dist.length - 1] += 1;
    }
    return { buckets: sortedBuckets, counts: dist };
  }

  snapshot() {
    return {
      bootTotals: Object.fromEntries(this.counters),
      lastSeen: Object.fromEntries(this.lastSeen),
      window: {
        windowMs: WINDOW_MS,
        counts: Object.fromEntries(
          [...this.counters.keys()].map((k) => [k, this.windowCount(k)])
        ),
      },
      ringSize: this.ring.length,
    };
  }

  recentEvents(limit = 200, filterKind = null) {
    const all = [...this.ring.items()];
    const filtered = filterKind ? all.filter((e) => e.kind === filterKind) : all;
    return filtered.slice(-limit);
  }

  // Enable periodic flush of buffered events to a JSONL file for offline
  // analysis. Rotates by size; older entries are dropped.
  startDrain() {
    if (!this.drainPath || this._drainTimer) return;
    this._drainTimer = setInterval(() => this._flushDrain(), DRAIN_INTERVAL_MS);
    if (typeof this._drainTimer.unref === "function") this._drainTimer.unref();
  }

  stopDrain() {
    if (this._drainTimer) {
      clearInterval(this._drainTimer);
      this._drainTimer = null;
    }
  }

  async _flushDrain() {
    if (!this.drainPath || this._pendingDrain.length === 0) return;
    const batch = this._pendingDrain.splice(0, this._pendingDrain.length);
    const payload = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";

    try {
      await fs.mkdir(path.dirname(this.drainPath), { recursive: true });
      await this._rotateIfNeeded();
      await fs.appendFile(this.drainPath, payload, "utf8");
    } catch (err) {
      // Drain failure is non-fatal — we drop the batch and continue.
      this.emit("drainError", err);
    }
  }

  async _rotateIfNeeded() {
    try {
      const stat = await fs.stat(this.drainPath);
      if (stat.size <= DRAIN_FILE_MAX_BYTES) return;
      const rotated = `${this.drainPath}.1`;
      await fs.rename(this.drainPath, rotated).catch(() => {});
    } catch {
      // File does not exist yet; nothing to rotate.
    }
  }
}

let _singleton = null;

export function getTelemetry({ drainPath } = {}) {
  if (!_singleton) {
    _singleton = new EventTelemetry({ drainPath });
    if (drainPath) _singleton.startDrain();
  }
  return _singleton;
}

export function recordEvent(kind, payload) {
  return getTelemetry().record(kind, payload);
}

export function getSnapshot() {
  return getTelemetry().snapshot();
}

export function getRecent(limit, filterKind) {
  return getTelemetry().recentEvents(limit, filterKind);
}

export { KIND as EVENT_KIND };
