import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/*
 * Persistence layer for per-request observability records.
 *
 * Writes are coalesced into a small in-memory queue and committed in
 * batches via SQLite transactions. A short-lived configuration cache
 * avoids re-reading user settings on every push.
 */

// --- Fallback tuning knobs (used when settings are unavailable) ---
const FALLBACK = Object.freeze({
  maxRecords: 200,
  batchSize: 20,
  flushIntervalMs: 5000,
  maxJsonSize: 5 * 1024,
});

const SETTINGS_CACHE_LIFETIME_MS = 5000;
const LOG_TAG = "[requestDetailsRepo]";

// Header keys that should never be persisted (substring match, case-insensitive)
const REDACTED_HEADER_NEEDLES = [
  "authorization",
  "x-api-key",
  "cookie",
  "token",
  "api-key",
];

// ---------------------------------------------------------------------------
// Settings snapshot — memoised for a few seconds to keep the hot path cheap.
// ---------------------------------------------------------------------------
const settingsCache = {
  value: null,
  fetchedAt: 0,
};

const intFromEnv = (envKey, fallback) =>
  parseInt(process.env[envKey] || String(fallback), 10);

async function readEffectiveConfig() {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.fetchedAt < SETTINGS_CACHE_LIFETIME_MS) {
    return settingsCache.value;
  }

  let snapshot;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const userSettings = await getSettings();

    const envSaysOn = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabledFlag = typeof userSettings.enableObservability === "boolean"
      ? userSettings.enableObservability
      : envSaysOn;

    snapshot = {
      enabled: enabledFlag,
      maxRecords: userSettings.observabilityMaxRecords
        || intFromEnv("OBSERVABILITY_MAX_RECORDS", FALLBACK.maxRecords),
      batchSize: userSettings.observabilityBatchSize
        || intFromEnv("OBSERVABILITY_BATCH_SIZE", FALLBACK.batchSize),
      flushIntervalMs: userSettings.observabilityFlushIntervalMs
        || intFromEnv("OBSERVABILITY_FLUSH_INTERVAL_MS", FALLBACK.flushIntervalMs),
      maxJsonSize: (userSettings.observabilityMaxJsonSize
        || intFromEnv("OBSERVABILITY_MAX_JSON_SIZE", 5)) * 1024,
    };
  } catch {
    // If settings cannot be loaded we silently disable observability.
    snapshot = { enabled: false, ...FALLBACK };
  }

  settingsCache.value = snapshot;
  settingsCache.fetchedAt = now;
  return snapshot;
}

// ---------------------------------------------------------------------------
// In-memory queue state.
// ---------------------------------------------------------------------------
const queueState = {
  pending: [],
  timerHandle: null,
  draining: false,
};

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------
function stripSensitiveHeaders(headerMap) {
  if (!headerMap || typeof headerMap !== "object") return {};

  const cloned = { ...headerMap };
  const isSecret = (name) => {
    const lower = name.toLowerCase();
    return REDACTED_HEADER_NEEDLES.some((needle) => lower.includes(needle));
  };

  Object.keys(cloned)
    .filter(isSecret)
    .forEach((name) => { delete cloned[name]; });

  return cloned;
}

function mintRecordId(modelName) {
  const isoNow = new Date().toISOString();
  const randomSlug = Math.random().toString(36).substring(2, 8);
  const safeModel = modelName
    ? modelName.replace(/[^a-zA-Z0-9-]/g, "-")
    : "unknown";
  return `${isoNow}-${randomSlug}-${safeModel}`;
}

function clampJsonPayload(payload, byteCap) {
  const serialised = JSON.stringify(payload || {});
  if (serialised.length <= byteCap) return payload || {};
  return {
    _truncated: true,
    _originalSize: serialised.length,
    _preview: serialised.substring(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Per-item normalisation. Mutates the incoming detail (matches prior
// behaviour where the queued object is filled in lazily).
// ---------------------------------------------------------------------------
function normaliseDetail(detail) {
  if (!detail.id) detail.id = mintRecordId(detail.model);
  if (!detail.timestamp) detail.timestamp = new Date().toISOString();
  if (detail.request?.headers) {
    detail.request.headers = stripSensitiveHeaders(detail.request.headers);
  }
}

function buildPersistableRow(detail, byteCap) {
  return {
    id: detail.id,
    provider: detail.provider || null,
    model: detail.model || null,
    connectionId: detail.connectionId || null,
    timestamp: detail.timestamp,
    status: detail.status || null,
    latency: detail.latency || {},
    tokens: detail.tokens || {},
    request: clampJsonPayload(detail.request, byteCap),
    providerRequest: clampJsonPayload(detail.providerRequest, byteCap),
    providerResponse: clampJsonPayload(detail.providerResponse, byteCap),
    response: clampJsonPayload(detail.response, byteCap),
  };
}

const UPSERT_SQL = `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`;
const COUNT_SQL = `SELECT COUNT(*) as c FROM requestDetails`;
const TRIM_SQL = `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`;

function commitBatch(db, batch, cfg) {
  db.transaction(() => {
    for (const detail of batch) {
      normaliseDetail(detail);
      const row = buildPersistableRow(detail, cfg.maxJsonSize);
      db.run(UPSERT_SQL, [
        row.id,
        row.timestamp,
        row.provider,
        row.model,
        row.connectionId,
        row.status,
        stringifyJson(row),
      ]);
    }

    // Enforce the rolling retention window.
    const countRow = db.get(COUNT_SQL);
    const total = countRow ? countRow.c : 0;
    if (total > cfg.maxRecords) {
      db.run(TRIM_SQL, [total - cfg.maxRecords]);
    }
  });
}

// ---------------------------------------------------------------------------
// Drain the queue. New items pushed mid-flush are also handled by the loop.
// ---------------------------------------------------------------------------
async function drainQueue() {
  if (queueState.draining || queueState.pending.length === 0) return;
  queueState.draining = true;

  try {
    while (queueState.pending.length > 0) {
      const batch = queueState.pending.splice(0, queueState.pending.length);
      const db = await getAdapter();
      const cfg = await readEffectiveConfig();
      commitBatch(db, batch, cfg);
    }
  } catch (err) {
    console.error(`${LOG_TAG} Batch write failed:`, err);
  } finally {
    queueState.draining = false;
  }
}

function scheduleDeferredFlush(delayMs) {
  if (queueState.timerHandle) return;
  queueState.timerHandle = setTimeout(() => {
    queueState.timerHandle = null;
    drainQueue().catch(() => { /* swallow — already logged inside drainQueue */ });
  }, delayMs);
}

function cancelDeferredFlush() {
  if (!queueState.timerHandle) return;
  clearTimeout(queueState.timerHandle);
  queueState.timerHandle = null;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
export async function saveRequestDetail(detail) {
  const cfg = await readEffectiveConfig();
  if (!cfg.enabled) return;

  queueState.pending.push(detail);

  // If the batch threshold has been crossed, kick off a flush right away.
  // drainQueue keeps looping while items keep arriving, so anything pushed
  // while we await the adapter will still be persisted.
  if (queueState.pending.length >= cfg.batchSize) {
    cancelDeferredFlush();
    drainQueue().catch((err) => console.error(`${LOG_TAG} flush err:`, err));
    return;
  }

  scheduleDeferredFlush(cfg.flushIntervalMs);
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
function buildWhereClause(filter) {
  const fragments = [];
  const bindings = [];

  const eqFilters = [
    ["provider", filter.provider],
    ["model", filter.model],
    ["connectionId", filter.connectionId],
    ["status", filter.status],
  ];

  for (const [col, val] of eqFilters) {
    if (val) {
      fragments.push(`${col} = ?`);
      bindings.push(val);
    }
  }

  if (filter.startDate) {
    fragments.push("timestamp >= ?");
    bindings.push(new Date(filter.startDate).toISOString());
  }
  if (filter.endDate) {
    fragments.push("timestamp <= ?");
    bindings.push(new Date(filter.endDate).toISOString());
  }

  const sql = fragments.length ? `WHERE ${fragments.join(" AND ")}` : "";
  return { sql, bindings };
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const { sql: whereSql, bindings } = buildWhereClause(filter);

  const countRow = db.get(
    `SELECT COUNT(*) as c FROM requestDetails ${whereSql}`,
    bindings
  );
  const totalItems = countRow ? countRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...bindings, pageSize, offset]
  );

  const details = rows.map((row) => parseJson(row.data, {}));

  return {
    details,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  if (!row) return null;
  return parseJson(row.data, null);
}

// ---------------------------------------------------------------------------
// Process lifecycle: drain anything still queued when the process is going
// away. Listeners are de-registered first so re-imports stay idempotent.
// ---------------------------------------------------------------------------
const TERMINATION_EVENTS = ["beforeExit", "SIGINT", "SIGTERM", "exit"];

const onProcessExit = async () => {
  cancelDeferredFlush();
  if (queueState.pending.length > 0) {
    await drainQueue();
  }
};

function attachLifecycleHooks() {
  for (const evt of TERMINATION_EVENTS) process.off(evt, onProcessExit);
  for (const evt of TERMINATION_EVENTS) process.on(evt, onProcessExit);
}

attachLifecycleHooks();
