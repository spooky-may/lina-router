import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// ---------------------------------------------------------------------------
// Column / blob metadata
// ---------------------------------------------------------------------------

const TABLE = "providerConnections";

const STRUCTURED_COLUMNS = Object.freeze([
  "id",
  "provider",
  "authType",
  "name",
  "email",
  "priority",
  "isActive",
  "createdAt",
  "updatedAt",
]);

const JSON_BLOB_FIELDS = Object.freeze([
  "displayName",
  "email",
  "globalPriority",
  "defaultModel",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "scope",
  "projectId",
  "apiKey",
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorAt",
  "rateLimitedUntil",
  "expiresIn",
  "errorCode",
  "consecutiveUseCount",
]);

// `expiresIn` was historically nullable; the cleanup path strips slightly
// different fields than the create path tracks (no `errorCode`).
const CLEANUP_NULLABLE_FIELDS = JSON_BLOB_FIELDS.filter(
  (fieldName) => fieldName !== "errorCode"
);

// ---------------------------------------------------------------------------
// RowMapper — pure (de)serialization between db rows and domain objects
// ---------------------------------------------------------------------------

const RowMapper = {
  fromRow(row) {
    if (!row) return null;
    const blob = parseJson(row.data, {});
    const activeFlag = row.isActive === 1 || row.isActive === true;
    return {
      ...blob,
      id: row.id,
      provider: row.provider,
      authType: row.authType,
      name: row.name,
      email: row.email,
      priority: row.priority,
      isActive: activeFlag,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },

  toRow(record) {
    const {
      id,
      provider,
      authType,
      name,
      email,
      priority,
      isActive,
      createdAt,
      updatedAt,
      ...blob
    } = record;

    return {
      id,
      provider,
      authType,
      name: name ?? null,
      email: email ?? null,
      priority: priority ?? null,
      isActive: isActive === false ? 0 : 1,
      data: stringifyJson(blob),
      createdAt,
      updatedAt,
    };
  },
};

// ---------------------------------------------------------------------------
// Prepared SQL fragments
// ---------------------------------------------------------------------------

const SQL = {
  selectAll: `SELECT * FROM ${TABLE}`,
  selectById: `SELECT * FROM ${TABLE} WHERE id = ?`,
  selectByProvider: `SELECT * FROM ${TABLE} WHERE provider = ?`,
  selectProviderOfId: `SELECT provider FROM ${TABLE} WHERE id = ?`,
  countByProvider: `SELECT COUNT(*) AS n FROM ${TABLE} WHERE provider = ?`,
  deleteById: `DELETE FROM ${TABLE} WHERE id = ?`,
  deleteByProvider: `DELETE FROM ${TABLE} WHERE provider = ?`,
  updatePriority: `UPDATE ${TABLE} SET priority = ? WHERE id = ?`,
  upsert: `INSERT INTO ${TABLE}(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
};

// ---------------------------------------------------------------------------
// ConnectionStore — encapsulates all db-touching operations
// ---------------------------------------------------------------------------

class ConnectionStore {
  constructor(adapter) {
    this.db = adapter;
  }

  // ---- low-level row I/O ------------------------------------------------

  writeRow(record) {
    const row = RowMapper.toRow(record);
    this.db.run(SQL.upsert, [
      row.id,
      row.provider,
      row.authType,
      row.name,
      row.email,
      row.priority,
      row.isActive,
      row.data,
      row.createdAt,
      row.updatedAt,
    ]);
  }

  fetchById(id) {
    const row = this.db.get(SQL.selectById, [id]);
    return RowMapper.fromRow(row);
  }

  fetchByProvider(providerId) {
    const rows = this.db.all(SQL.selectByProvider, [providerId]);
    return rows.map((r) => RowMapper.fromRow(r));
  }

  // ---- priority bookkeeping --------------------------------------------

  // Rebalances priorities to a 1..N sequence within a single provider.
  // Caller is responsible for the surrounding transaction.
  resequencePriorities(providerId) {
    const siblings = this.fetchByProvider(providerId);

    siblings.sort((left, right) => {
      const priorityDelta = (left.priority || 0) - (right.priority || 0);
      if (priorityDelta !== 0) return priorityDelta;
      const leftStamp = new Date(left.updatedAt || 0);
      const rightStamp = new Date(right.updatedAt || 0);
      return rightStamp - leftStamp;
    });

    siblings.forEach((conn, idx) => {
      this.db.run(SQL.updatePriority, [idx + 1, conn.id]);
    });
  }

  // ---- list / lookup ----------------------------------------------------

  list(filter) {
    const where = [];
    const params = [];

    const providerFilter = filter.provider;
    if (providerFilter) {
      where.push("provider = ?");
      params.push(providerFilter);
    }

    const activeFilter = filter.isActive;
    if (activeFilter !== undefined) {
      where.push("isActive = ?");
      params.push(activeFilter ? 1 : 0);
    }

    const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    const sql = `${SQL.selectAll}${whereClause}`;

    const items = this.db.all(sql, params).map((r) => RowMapper.fromRow(r));
    return items.sort(
      (left, right) => (left.priority || 999) - (right.priority || 999)
    );
  }

  // ---- mutations: create -----------------------------------------------

  static #findDuplicate(siblings, payload) {
    if (payload.authType === "oauth" && payload.email) {
      return siblings.find(
        (entry) => entry.authType === "oauth" && entry.email === payload.email
      );
    }
    if (payload.authType === "apikey" && payload.name) {
      return siblings.find(
        (entry) => entry.authType === "apikey" && entry.name === payload.name
      );
    }
    return null;
  }

  static #computeNextPriority(siblings, requested) {
    if (requested) return requested;
    return siblings.reduce(
      (max, entry) => Math.max(max, entry.priority || 0),
      0
    ) + 1;
  }

  static #computeName(payload, siblingCount) {
    if (payload.name) return payload.name;
    if (payload.authType !== "oauth") return null;
    return payload.email || `Account ${siblingCount + 1}`;
  }

  static #buildNewRecord(payload, timestamp, siblings) {
    const record = {
      id: uuidv4(),
      provider: payload.provider,
      authType: payload.authType || "oauth",
      name: ConnectionStore.#computeName(payload, siblings.length),
      priority: ConnectionStore.#computeNextPriority(siblings, payload.priority),
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    JSON_BLOB_FIELDS.forEach((fieldName) => {
      const value = payload[fieldName];
      if (value === undefined || value === null) return;
      record[fieldName] = value;
    });

    const psd = payload.providerSpecificData;
    if (psd && Object.keys(psd).length > 0) {
      record.providerSpecificData = psd;
    }

    if (payload.email !== undefined) {
      record.email = payload.email;
    }

    return record;
  }

  create(payload) {
    const timestamp = new Date().toISOString();
    let result;

    this.db.transaction(() => {
      try {
        const siblings = this.fetchByProvider(payload.provider);
        const duplicate = ConnectionStore.#findDuplicate(siblings, payload);

        if (duplicate) {
          const merged = { ...duplicate, ...payload, updatedAt: timestamp };
          this.writeRow(merged);
          result = merged;
          return;
        }

        const fresh = ConnectionStore.#buildNewRecord(payload, timestamp, siblings);
        this.writeRow(fresh);
        this.resequencePriorities(payload.provider);
        result = fresh;
      } catch (err) {
        // Preserve original error semantics — just re-raise so the adapter
        // can roll back the transaction.
        throw err;
      }
    });

    return result;
  }

  // ---- mutations: update / delete --------------------------------------

  update(id, patch) {
    let result;

    this.db.transaction(() => {
      try {
        const row = this.db.get(SQL.selectById, [id]);

        if (!row) {
          result = null;
          return;
        }

        const current = RowMapper.fromRow(row);
        const merged = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };

        this.writeRow(merged);

        if (patch.priority !== undefined) {
          this.resequencePriorities(current.provider);
        }

        result = merged;
      } catch (err) {
        throw err;
      }
    });

    return result;
  }

  deleteOne(id) {
    let didRemove = false;

    this.db.transaction(() => {
      try {
        const row = this.db.get(SQL.selectProviderOfId, [id]);
        if (!row) return;
        this.db.run(SQL.deleteById, [id]);
        this.resequencePriorities(row.provider);
        didRemove = true;
      } catch (err) {
        throw err;
      }
    });

    return didRemove;
  }

  deleteAllOfProvider(providerId) {
    const countRow = this.db.get(SQL.countByProvider, [providerId]);
    this.db.run(SQL.deleteByProvider, [providerId]);
    return countRow?.n || 0;
  }

  reorder(providerId) {
    this.db.transaction(() => {
      this.resequencePriorities(providerId);
    });
  }

  // ---- maintenance ------------------------------------------------------

  cleanup() {
    let strippedCount = 0;

    this.db.transaction(() => {
      try {
        const rows = this.db.all(SQL.selectAll);

        rows.forEach((row) => {
          const record = RowMapper.fromRow(row);
          let dirty = false;

          CLEANUP_NULLABLE_FIELDS.forEach((fieldName) => {
            const value = record[fieldName];
            const isNullish = value === null || value === undefined;
            if (!isNullish) return;
            if (!(fieldName in record)) return;
            delete record[fieldName];
            strippedCount += 1;
            dirty = true;
          });

          const psd = record.providerSpecificData;
          if (psd && Object.keys(psd).length === 0) {
            delete record.providerSpecificData;
            strippedCount += 1;
            dirty = true;
          }

          if (dirty) this.writeRow(record);
        });
      } catch (err) {
        throw err;
      }
    });

    return strippedCount;
  }
}

// ---------------------------------------------------------------------------
// Store factory — creates a fresh ConnectionStore bound to the current adapter
// ---------------------------------------------------------------------------

async function openStore() {
  const adapter = await getAdapter();
  return new ConnectionStore(adapter);
}

// ---------------------------------------------------------------------------
// Public API — thin wrappers around ConnectionStore
//
// Names and signatures here are stable contracts and must not change.
// ---------------------------------------------------------------------------

export async function getProviderConnectionById(id) {
  const store = await openStore();
  return store.fetchById(id);
}

export async function getProviderConnections(filter = {}) {
  const store = await openStore();
  return store.list(filter);
}

export async function createProviderConnection(data) {
  const store = await openStore();
  return store.create(data);
}

export async function updateProviderConnection(id, data) {
  const store = await openStore();
  return store.update(id, data);
}

export async function deleteProviderConnection(id) {
  const store = await openStore();
  return store.deleteOne(id);
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const store = await openStore();
  return store.deleteAllOfProvider(providerId);
}

export async function reorderProviderConnections(providerId) {
  const store = await openStore();
  store.reorder(providerId);
}

export async function cleanupProviderConnections() {
  const store = await openStore();
  return store.cleanup();
}
