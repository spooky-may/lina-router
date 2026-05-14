import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Fields stored in the JSON blob column rather than dedicated columns
const BLOB_TRACKED_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount",
];

const CORE_COLUMNS = ["id", "provider", "authType", "name", "email", "priority", "isActive", "createdAt", "updatedAt"];

function hydrate(rawRow) {
  if (!rawRow) return null;
  const extra = parseJson(rawRow.data, {});
  return {
    ...extra,
    id: rawRow.id,
    provider: rawRow.provider,
    authType: rawRow.authType,
    name: rawRow.name,
    email: rawRow.email,
    priority: rawRow.priority,
    isActive: rawRow.isActive === 1 || rawRow.isActive === true,
    createdAt: rawRow.createdAt,
    updatedAt: rawRow.updatedAt,
  };
}

function dehydrate(entry) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = entry;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function persist(db, entry) {
  const record = dehydrate(entry);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [record.id, record.provider, record.authType, record.name, record.email, record.priority, record.isActive, record.data, record.createdAt, record.updatedAt]
  );
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const conditions = [];
  const bindings = [];
  if (filter.provider) {
    const clause = "provider = ?";
    conditions.push(clause);
    bindings.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    const clause = "isActive = ?";
    conditions.push(clause);
    bindings.push(filter.isActive ? 1 : 0);
  }
  const sql = `SELECT * FROM providerConnections${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
  const results = db.all(sql, bindings).map(hydrate);
  results.sort((x, y) => (x.priority || 999) - (y.priority || 999));
  return results;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const rawRow = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return hydrate(rawRow);
}

// Reassign sequential priority values within a provider — must run inside a transaction
function compactPriorities(db, providerId) {
  const items = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(hydrate);
  items.sort((x, y) => {
    const delta = (x.priority || 0) - (y.priority || 0);
    if (delta !== 0) return delta;
    return new Date(y.updatedAt || 0) - new Date(x.updatedAt || 0);
  });
  items.forEach((entry, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, entry.id]);
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let outcome;

  db.transaction(() => {
    const existing = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(hydrate);

    let duplicate = null;
    if (data.authType === "oauth" && data.email) {
      duplicate = existing.find(entry => entry.authType === "oauth" && entry.email === data.email);
    } else if (data.authType === "apikey" && data.name) {
      duplicate = existing.find(entry => entry.authType === "apikey" && entry.name === data.name);
    }

    if (duplicate) {
      const merged = { ...duplicate, ...data, updatedAt: now };
      persist(db, merged);
      outcome = merged;
      return;
    }

    let resolvedName = data.name || null;
    if (!resolvedName && data.authType === "oauth") {
      resolvedName = data.email || `Account ${existing.length + 1}`;
    }
    let slotPriority = data.priority;
    if (!slotPriority) {
      slotPriority = existing.reduce((acc, entry) => Math.max(acc, entry.priority || 0), 0) + 1;
    }

    const newEntry = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: resolvedName,
      priority: slotPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const field of BLOB_TRACKED_FIELDS) {
      if (data[field] !== undefined && data[field] !== null) newEntry[field] = data[field];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      newEntry.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) newEntry.email = data.email;

    persist(db, newEntry);
    compactPriorities(db, data.provider);
    outcome = newEntry;
  });

  return outcome;
}

// Atomic merge to prevent OAuth refresh token race conditions
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let outcome;
  db.transaction(() => {
    const rawRow = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!rawRow) { outcome = null; return; }
    const current = hydrate(rawRow);
    const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
    persist(db, merged);
    if (data.priority !== undefined) compactPriorities(db, current.provider);
    outcome = merged;
  });
  return outcome;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let removed = false;
  db.transaction(() => {
    const rawRow = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!rawRow) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    compactPriorities(db, rawRow.provider);
    removed = true;
  });
  return removed;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const countRow = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return countRow?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => compactPriorities(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const nullableFields = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let totalCleaned = 0;
  db.transaction(() => {
    const allRows = db.all(`SELECT * FROM providerConnections`);
    for (const rawRow of allRows) {
      const entry = hydrate(rawRow);
      let needsWrite = false;
      for (const field of nullableFields) {
        if (entry[field] === null || entry[field] === undefined) {
          if (field in entry) { delete entry[field]; totalCleaned++; needsWrite = true; }
        }
      }
      if (entry.providerSpecificData && Object.keys(entry.providerSpecificData).length === 0) {
        delete entry.providerSpecificData;
        totalCleaned++;
        needsWrite = true;
      }
      if (needsWrite) persist(db, entry);
    }
  });
  return totalCleaned;
}
