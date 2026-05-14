import fs from "node:fs";
import path from "node:path";
import { LEGACY_FILES, DB_DIR, DATA_FILE } from "./paths.js";
import { TABLES, buildCreateTableSql } from "./schema.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import { makeBackupDir, backupFile, pruneOldBackups } from "./backup.js";
import { getAppVersion } from "./version.js";
import { stringifyJson } from "./helpers/jsonCol.js";

// Sentinel file written after a successful JSON import so we never repeat it
// even if the user deletes data.sqlite and starts fresh.
const JSON_IMPORT_STAMP = path.join(DB_DIR, ".migrated-from-json");

// Tracks which db instances have already gone through startup checks this process.
const _processedInstances = new WeakSet();

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function dbIsEmpty(db) {
  // _meta won't exist on a brand-new database — treat any error as "empty"
  try {
    const result = db.get(`SELECT COUNT(*) as c FROM _meta`);
    return !result || result.c === 0;
  } catch {
    return true;
  }
}

// Applies all pending numbered migrations in order, safe to call even if some
// versions have already been applied (skips anything <= current schemaVersion).
function applyMigrationChain(db) {
  db.exec(buildCreateTableSql("_meta", TABLES._meta));

  const storedVersion = parseInt(getMetaSync(db, "schemaVersion", "0"), 10) || 0;
  const headVersion = latestVersion();
  if (storedVersion >= headVersion) return { applied: 0, from: storedVersion, to: storedVersion };

  const outstanding = MIGRATIONS.filter((entry) => entry.version > storedVersion);
  let lastRan = storedVersion;
  for (const entry of outstanding) {
    db.transaction(() => {
      entry.up(db);
      setMetaSync(db, "schemaVersion", entry.version);
    });
    lastRan = entry.version;
    console.log(`[DB][migrate] applied #${entry.version} ${entry.name}`);
  }
  return { applied: outstanding.length, from: storedVersion, to: lastRan };
}

// Walks the TABLES definition and ensures the live schema matches — adds any
// columns or indexes that are declared but not yet present. Never removes anything.
function reconcileSchema(db) {
  for (const [tbl, definition] of Object.entries(TABLES)) {
    db.exec(buildCreateTableSql(tbl, definition));

    const liveColumns = db.all(`PRAGMA table_info(${tbl})`);
    const knownNames = new Set(liveColumns.map((col) => col.name));

    for (const [colName, colSpec] of Object.entries(definition.columns)) {
      if (knownNames.has(colName)) continue;

      // Strip constraints that SQLite only accepts at CREATE TABLE time
      const addableSpec = colSpec
        .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
        .replace(/UNIQUE/i, "")
        .trim();
      try {
        db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${colName} ${addableSpec}`);
        console.log(`[DB][sync] +column ${tbl}.${colName}`);
      } catch (err) {
        console.warn(`[DB][sync] add column ${tbl}.${colName} failed: ${err.message}`);
      }
    }

    for (const indexSql of definition.indexes || []) {
      try { db.exec(indexSql); } catch {}
    }
  }
}

// Pulls core application records out of the old JSON blob and writes them
// into the normalized SQLite tables. Called inside a transaction.
function seedFromMainJson(db, payload) {
  if (!payload || typeof payload !== "object") return;

  if (payload.settings) {
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
  }

  for (const conn of payload.providerConnections || []) {
    const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...extras } = conn;
    db.run(
      `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(extras), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }

  for (const node of payload.providerNodes || []) {
    const { id, type, name, createdAt, updatedAt, ...extras } = node;
    db.run(
      `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, type || null, name || null, stringifyJson(extras), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }

  for (const pool of payload.proxyPools || []) {
    const { id, isActive, testStatus, createdAt, updatedAt, ...extras } = pool;
    db.run(
      `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(extras), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }

  for (const key of payload.apiKeys || []) {
    db.run(
      `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [key.id, key.key, key.name || null, key.machineId || null, key.isActive === false ? 0 : 1, key.createdAt || new Date().toISOString()]
    );
  }

  for (const combo of payload.combos || []) {
    db.run(
      `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [combo.id, combo.name, combo.kind || null, stringifyJson(combo.models || []), combo.createdAt || new Date().toISOString(), combo.updatedAt || new Date().toISOString()]
    );
  }

  for (const [alias, model] of Object.entries(payload.modelAliases || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [alias, stringifyJson(model)]);
  }

  for (const modelDef of payload.customModels || []) {
    const kvKey = `${modelDef.providerAlias}|${modelDef.id}|${modelDef.type || "llm"}`;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [kvKey, stringifyJson(modelDef)]);
  }

  for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
  }

  for (const [provider, models] of Object.entries(payload.pricing || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
  }
}

function seedFromUsageJson(db, payload) {
  if (!payload || typeof payload !== "object") return;

  for (const event of payload.history || []) {
    const tok = event.tokens || {};
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.timestamp || new Date().toISOString(),
        event.provider || null, event.model || null, event.connectionId || null, event.apiKey || null, event.endpoint || null,
        tok.prompt_tokens || tok.input_tokens || 0,
        tok.completion_tokens || tok.output_tokens || 0,
        event.cost || 0,
        event.status || "ok",
        stringifyJson(tok),
        stringifyJson({}),
      ]
    );
  }

  for (const [dateKey, summary] of Object.entries(payload.dailySummary || {})) {
    db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, stringifyJson(summary)]);
  }

  if (typeof payload.totalRequestsLifetime === "number") {
    setMetaSync(db, "totalRequestsLifetime", payload.totalRequestsLifetime);
  }
}

function seedFromDisabledJson(db, payload) {
  if (!payload || typeof payload.disabled !== "object") return;
  for (const [provider, ids] of Object.entries(payload.disabled)) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [provider, stringifyJson(ids || [])]);
  }
}

function seedFromDetailsJson(db, payload) {
  if (!payload || !Array.isArray(payload.records)) return;
  for (const record of payload.records) {
    db.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.timestamp || new Date().toISOString(), record.provider || null, record.model || null, record.connectionId || null, record.status || null, stringifyJson(record)]
    );
  }
}

// Startup hook — runs versioned migrations, schema reconciliation, and the
// one-time JSON import. Idempotent: second call with the same db instance is a no-op.
export async function runMigrationOnce(adapter) {
  if (_processedInstances.has(adapter)) return;
  _processedInstances.add(adapter);

  // Sample emptiness now — once we write schemaVersion the check would return false
  // and we'd miss the window to seed legacy data on a brand new install.
  const wasEmpty = dbIsEmpty(adapter);

  // Step 1: bring schema version up to date
  const chainResult = applyMigrationChain(adapter);

  // Step 2: fill in any columns/indexes added since last boot
  reconcileSchema(adapter);

  // Step 3: one-time import of data from the old JSON-file storage format
  const stampExists = fs.existsSync(JSON_IMPORT_STAMP);
  const jsonMain     = loadJsonFile(LEGACY_FILES.main);
  const jsonUsage    = loadJsonFile(LEGACY_FILES.usage);
  const jsonDisabled = loadJsonFile(LEGACY_FILES.disabled);
  const jsonDetails  = loadJsonFile(LEGACY_FILES.details);
  const foundLegacy  = !!(jsonMain || jsonUsage || jsonDisabled || jsonDetails);

  if (wasEmpty && foundLegacy && !stampExists) {
    const startMs = Date.now();
    const snapshotDir = makeBackupDir("migrate-from-json");
    for (const legacyPath of Object.values(LEGACY_FILES)) backupFile(legacyPath, snapshotDir);

    adapter.transaction(() => {
      seedFromMainJson(adapter, jsonMain);
      seedFromUsageJson(adapter, jsonUsage);
      seedFromDisabledJson(adapter, jsonDisabled);
      seedFromDetailsJson(adapter, jsonDetails);
      setMetaSync(adapter, "appVersion", getAppVersion());
      setMetaSync(adapter, "migratedAt", new Date().toISOString());
    });

    try { fs.writeFileSync(JSON_IMPORT_STAMP, new Date().toISOString()); } catch {}
    pruneOldBackups();
    console.log(`[DB][migrate] JSON → SQLite in ${Date.now() - startMs}ms | legacy JSON kept at DATA_DIR | backup: ${snapshotDir}`);
    return;
  }

  if (wasEmpty) {
    setMetaSync(adapter, "appVersion", getAppVersion());
    return;
  }

  // Step 4: when the app version changes, snapshot the database as a safety net
  const prevVersion = getMetaSync(adapter, "appVersion", null);
  const currVersion = getAppVersion();
  if (prevVersion && prevVersion !== currVersion) {
    const snapshotDir = makeBackupDir(`upgrade-${prevVersion}-to-${currVersion}`);
    try { backupFile(DATA_FILE, snapshotDir); } catch {}
    setMetaSync(adapter, "appVersion", currVersion);
    pruneOldBackups();
    console.log(`[DB][migrate] App ${prevVersion} → ${currVersion} | schema ${chainResult.from} → ${chainResult.to} | backup: ${snapshotDir}`);
  } else if (chainResult.applied > 0) {
    // Schema bumped without a matching app version change — still worth snapshotting
    const snapshotDir = makeBackupDir(`schema-${chainResult.from}-to-${chainResult.to}`);
    try { backupFile(DATA_FILE, snapshotDir); } catch {}
    pruneOldBackups();
  }
}
