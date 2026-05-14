// =============================================================================
// /sync/:machineId — bidirectional provider state sync between Cloud and Web.
//
// Strategy: timestamp-based winner-takes-all per provider entry. The Cloud
// side stores the merged view; Web clients PUSH/PULL through this handler.
// =============================================================================

import * as logger from "../utils/logger.js";
import {
  getMachineData,
  saveMachineData,
  deleteMachineData,
} from "../services/storage.js";

const LOG_TAG = "SYNC";

const RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
});

const CORS_PREFLIGHT_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
});

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function preflightResponse() {
  return new Response(null, { headers: CORS_PREFLIGHT_HEADERS });
}

function extractMachineId(request) {
  const url = new URL(request.url);
  // path layout: /sync/:machineId
  return url.pathname.split("/")[2] || null;
}

// -----------------------------------------------------------------------------
// Provider snapshot shape — single source of truth for what we persist.
// -----------------------------------------------------------------------------

const PROVIDER_FIELDS = Object.freeze([
  "id",
  "provider",
  "authType",
  "name",
  "displayName",
  "email",
  "priority",
  "globalPriority",
  "defaultModel",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "expiresIn",
  "tokenType",
  "scope",
  "idToken",
  "projectId",
  "apiKey",
  "isActive",
  "createdAt",
]);

function snapshotProvider(src) {
  const out = {};
  for (const field of PROVIDER_FIELDS) {
    out[field] = src[field];
  }
  out.providerSpecificData = src.providerSpecificData || {};
  out.status = src.status || "active";
  out.lastError = src.lastError || null;
  out.lastErrorAt = src.lastErrorAt || null;
  out.errorCode = src.errorCode || null;
  out.rateLimitedUntil = src.rateLimitedUntil || null;
  out.updatedAt = src.updatedAt || new Date().toISOString();
  return out;
}

// -----------------------------------------------------------------------------
// Merge — pick newest version of a provider entry.
// -----------------------------------------------------------------------------

function resolveProviderMerge(fromWeb, fromCloud, deltaLog, providerId) {
  const webStamp = new Date(fromWeb.updatedAt || 0).getTime();
  const cloudStamp = new Date(fromCloud.updatedAt || 0).getTime();

  const cloudWins = cloudStamp > webStamp;
  const winner = cloudWins ? fromCloud : fromWeb;

  const snapshot = snapshotProvider(winner);
  snapshot.updatedAt = new Date().toISOString();

  if (cloudWins) {
    deltaLog.fromWorker.push(providerId);
  } else {
    deltaLog.updated.push(providerId);
  }

  return snapshot;
}

// -----------------------------------------------------------------------------
// Method handlers
// -----------------------------------------------------------------------------

async function handleGet(machineId, env) {
  const record = await getMachineData(machineId, env);

  if (!record) {
    logger.warn(LOG_TAG, "No data found", { machineId });
    return jsonResponse({ error: "No data found" }, 404);
  }

  logger.info(LOG_TAG, "Data retrieved", { machineId });
  return jsonResponse({ success: true, data: record });
}

async function handlePost(request, machineId, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    logger.warn(LOG_TAG, "Invalid JSON body", { machineId });
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const incomingProviders = payload.providers;
  if (!incomingProviders || !Array.isArray(incomingProviders)) {
    logger.warn(LOG_TAG, "Missing or invalid providers array", { machineId });
    return jsonResponse({ error: "Missing providers array" }, 400);
  }

  const stored =
    (await getMachineData(machineId, env)) || {
      providers: {},
      modelAliases: {},
      apiKeys: [],
    };

  const mergedProviders = {};
  const deltaLog = { updated: [], fromWorker: [] };

  for (const incoming of incomingProviders) {
    const pid = incoming.id;
    if (!pid) {
      logger.warn(LOG_TAG, "Provider missing id", { provider: incoming.provider });
      continue;
    }

    const existing = stored.providers[pid];
    if (!existing) {
      mergedProviders[pid] = snapshotProvider(incoming);
      deltaLog.updated.push(pid);
      continue;
    }

    mergedProviders[pid] = resolveProviderMerge(incoming, existing, deltaLog, pid);
  }

  const finalDoc = {
    providers: mergedProviders,
    modelAliases: payload.modelAliases || stored.modelAliases || {},
    combos: payload.combos || stored.combos || [],
    apiKeys: payload.apiKeys || stored.apiKeys || [],
    updatedAt: new Date().toISOString(),
  };

  await saveMachineData(machineId, finalDoc, env);

  logger.info(LOG_TAG, "Data synced successfully", {
    machineId,
    providerCount: Object.keys(mergedProviders).length,
    changes: deltaLog,
  });

  return jsonResponse({
    success: true,
    data: finalDoc,
    changes: deltaLog,
  });
}

async function handleDelete(machineId, env) {
  await deleteMachineData(machineId, env);
  logger.info(LOG_TAG, "Data deleted", { machineId });
  return jsonResponse({
    success: true,
    message: "Data deleted successfully",
  });
}

// -----------------------------------------------------------------------------
// Method dispatch table — replaces the procedural switch in the original.
// -----------------------------------------------------------------------------

const METHOD_TABLE = {
  GET: (req, machineId, env) => handleGet(machineId, env),
  POST: (req, machineId, env) => handlePost(req, machineId, env),
  DELETE: (req, machineId, env) => handleDelete(machineId, env),
};

// -----------------------------------------------------------------------------
// Public exports
// -----------------------------------------------------------------------------

export async function handleSync(request, env, ctx) {
  if (request.method === "OPTIONS") return preflightResponse();

  const machineId = extractMachineId(request);
  if (!machineId) {
    logger.warn(LOG_TAG, "Missing machineId in path");
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  const dispatcher = METHOD_TABLE[request.method];
  if (!dispatcher) {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  return dispatcher(request, machineId, env);
}

export function updateProviderStatus(providers, providerId, status, error = null, errorCode = null) {
  const target = providers[providerId];
  if (!target) return providers;

  const nowIso = new Date().toISOString();
  target.status = status;
  target.lastError = error;
  target.lastErrorAt = error ? nowIso : null;
  target.errorCode = errorCode;
  target.updatedAt = nowIso;

  return providers;
}
