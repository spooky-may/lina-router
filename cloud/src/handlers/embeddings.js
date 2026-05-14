import { getModelInfoCore } from "open-sse/services/model.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import {
  checkFallbackError,
  isAccountUnavailable,
  getEarliestRateLimitedUntil,
  getUnavailableUntil,
  formatRetryAfter
} from "open-sse/services/accountFallback.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { parseApiKey, extractBearerToken } from "../utils/apiKey.js";
import { getMachineData, saveMachineData } from "../services/storage.js";

// Preflight handler shared across routes — returns permissive CORS headers.
function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/embeddings  (and legacy /{deviceId}/v1/embeddings)
 *
 * Steps:
 *   1. Resolve deviceId from the URL override or from the bearer token.
 *   2. Confirm the bearer token is valid for this device.
 *   3. Decode the request body and validate required fields.
 *   4. Look up model metadata and map to a provider + model slug.
 *   5. Run the provider-credential fallback loop, delegating to handleEmbeddingsCore.
 *
 * @param {Request} req
 * @param {object} env   - Cloudflare Worker environment bindings
 * @param {object} ctx   - Execution context (waitUntil, etc.)
 * @param {string|null} deviceIdFromPath - Pre-extracted device ID from URL, or null
 */
export async function handleEmbeddings(req, env, ctx, deviceIdFromPath = null) {
  if (req.method === "OPTIONS") return preflight();

  // Determine the device/machine ID we're acting on behalf of.
  let deviceId = deviceIdFromPath;

  if (!deviceId) {
    const rawToken = extractBearerToken(req);
    if (!rawToken) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");

    const tokenParts = await parseApiKey(rawToken);
    if (!tokenParts) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key format");

    if (!tokenParts.isNewFormat || !tokenParts.machineId) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "API key does not contain machineId. Use /{machineId}/v1/... endpoint for old format keys."
      );
    }
    deviceId = tokenParts.machineId;
  }

  // Reject requests whose token does not match the device record.
  const tokenOk = await verifyToken(req, deviceId, env);
  if (!tokenOk) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");

  // Deserialize request payload.
  let payload;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const requestedModel = payload.model;
  if (!requestedModel) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!payload.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  log.info("EMBEDDINGS", `${deviceId} | ${requestedModel}`);

  // Map the model string to a provider + canonical model slug.
  const deviceRecord = await getMachineData(deviceId, env);
  const resolvedModel = await getModelInfoCore(requestedModel, deviceRecord?.modelAliases || {});
  if (!resolvedModel.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider: targetProvider, model: targetModel } = resolvedModel;
  log.info("EMBEDDINGS_MODEL", `${targetProvider.toUpperCase()} | ${targetModel}`);

  // Fallback loop: try accounts in priority order, skipping unavailable ones.
  let skippedAccountId = null;
  let previousError = null;
  let previousStatus = null;

  for (;;) {
    const account = await pickAccount(deviceId, targetProvider, env, skippedAccountId);

    if (!account || account.allRateLimited) {
      if (account?.allRateLimited) {
        const secsUntilRetry = Math.ceil(
          (new Date(account.retryAfter).getTime() - Date.now()) / 1000
        );
        const errorDetail = previousError || account.lastError || "Unavailable";
        const message = `[${targetProvider}/${targetModel}] ${errorDetail} (${account.retryAfterHuman})`;
        const httpCode = previousStatus || Number(account.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("EMBEDDINGS", `${targetProvider.toUpperCase()} | ${message}`);
        return new Response(
          JSON.stringify({ error: { message } }),
          {
            status: httpCode,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.max(secsUntilRetry, 1))
            }
          }
        );
      }

      if (!skippedAccountId) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${targetProvider}`);
      }

      log.warn("EMBEDDINGS", `${targetProvider.toUpperCase()} | no more accounts`);
      return new Response(
        JSON.stringify({ error: previousError || "All accounts unavailable" }),
        {
          status: previousStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    log.debug("EMBEDDINGS", `account=${account.id}`, { provider: targetProvider });

    const outcome = await handleEmbeddingsCore({
      body: payload,
      modelInfo: { provider: targetProvider, model: targetModel },
      credentials: account,
      log,
      onCredentialsRefreshed: async (refreshed) => {
        await persistTokenUpdate(deviceId, account.id, refreshed, env);
      },
      onRequestSuccess: async () => {
        await resetAccountErrors(deviceId, account.id, account, env);
      }
    });

    if (outcome.success) return outcome.response;

    const { shouldFallback } = checkFallbackError(outcome.status, outcome.error);

    if (shouldFallback) {
      log.warn("EMBEDDINGS_FALLBACK", `${targetProvider.toUpperCase()} | ${account.id} | ${outcome.status}`);
      await banAccount(deviceId, account.id, outcome.status, outcome.error, env);
      skippedAccountId = account.id;
      previousError = outcome.error;
      previousStatus = outcome.status;
      continue;
    }

    return outcome.response;
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

// Checks that the bearer token in the request matches one stored for this device.
async function verifyToken(req, deviceId, env) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const suppliedKey = authHeader.slice(7);
  const record = await getMachineData(deviceId, env);
  return record?.apiKeys?.some(entry => entry.key === suppliedKey) || false;
}

// Returns the highest-priority available account for a given provider,
// or a sentinel object describing a rate-limited state if all accounts are blocked.
async function pickAccount(deviceId, provider, env, skipId = null) {
  const record = await getMachineData(deviceId, env);
  if (!record?.providers) return null;

  const eligible = Object.entries(record.providers)
    .filter(([id, conn]) => {
      if (conn.provider !== provider || !conn.isActive) return false;
      if (skipId && id === skipId) return false;
      if (isAccountUnavailable(conn.rateLimitedUntil)) return false;
      return true;
    })
    .sort((a, b) => (a[1].priority || 999) - (b[1].priority || 999));

  if (eligible.length > 0) {
    const [chosenId, chosenConn] = eligible[0];
    return {
      id: chosenId,
      apiKey: chosenConn.apiKey,
      accessToken: chosenConn.accessToken,
      refreshToken: chosenConn.refreshToken,
      expiresAt: chosenConn.expiresAt,
      projectId: chosenConn.projectId,
      providerSpecificData: chosenConn.providerSpecificData,
      status: chosenConn.status,
      lastError: chosenConn.lastError,
      rateLimitedUntil: chosenConn.rateLimitedUntil
    };
  }

  // No eligible accounts — check if they're all rate-limited (vs. simply absent).
  const allForProvider = Object.entries(record.providers)
    .filter(([, conn]) => conn.provider === provider && conn.isActive)
    .map(([, conn]) => conn);

  const soonestUnlock = getEarliestRateLimitedUntil(allForProvider);
  if (!soonestUnlock) return null;

  const blocked = allForProvider.filter(
    c => c.rateLimitedUntil && new Date(c.rateLimitedUntil).getTime() > Date.now()
  );
  const soonest = blocked.sort(
    (a, b) => new Date(a.rateLimitedUntil) - new Date(b.rateLimitedUntil)
  )[0];

  return {
    allRateLimited: true,
    retryAfter: soonestUnlock,
    retryAfterHuman: formatRetryAfter(soonestUnlock),
    lastError: soonest?.lastError || null,
    lastErrorCode: soonest?.errorCode || null
  };
}

// Marks a connection as temporarily unavailable after a failed request,
// applying exponential backoff via backoffLevel.
async function banAccount(deviceId, connId, statusCode, errDetail, env) {
  const record = await getMachineData(deviceId, env);
  if (!record?.providers?.[connId]) return;

  const existing = record.providers[connId];
  const currentBackoff = existing.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(statusCode, errDetail, currentBackoff);
  const blockedUntil = getUnavailableUntil(cooldownMs);
  const truncatedReason = typeof errDetail === "string" ? errDetail.slice(0, 100) : "Provider error";
  const now = new Date().toISOString();

  record.providers[connId].rateLimitedUntil = blockedUntil;
  record.providers[connId].status = "unavailable";
  record.providers[connId].lastError = truncatedReason;
  record.providers[connId].errorCode = statusCode || null;
  record.providers[connId].lastErrorAt = now;
  record.providers[connId].backoffLevel = newBackoffLevel ?? currentBackoff;
  record.providers[connId].updatedAt = now;

  await saveMachineData(deviceId, record, env);
  log.warn("EMBEDDINGS_ACCOUNT", `${connId} | unavailable until ${blockedUntil}`);
}

// Clears any error / rate-limit state from a connection after a successful call.
async function resetAccountErrors(deviceId, connId, snapshot, env) {
  const needsReset =
    snapshot.status === "unavailable" ||
    snapshot.lastError ||
    snapshot.rateLimitedUntil;

  if (!needsReset) return;

  const record = await getMachineData(deviceId, env);
  if (!record?.providers?.[connId]) return;

  record.providers[connId].status = "active";
  record.providers[connId].lastError = null;
  record.providers[connId].lastErrorAt = null;
  record.providers[connId].rateLimitedUntil = null;
  record.providers[connId].backoffLevel = 0;
  record.providers[connId].updatedAt = new Date().toISOString();

  await saveMachineData(deviceId, record, env);
  log.info("EMBEDDINGS_ACCOUNT", `${connId} | error cleared`);
}

// Persists refreshed OAuth tokens back to the device record.
async function persistTokenUpdate(deviceId, connId, freshCreds, env) {
  const record = await getMachineData(deviceId, env);
  if (!record?.providers?.[connId]) return;

  record.providers[connId].accessToken = freshCreds.accessToken;

  if (freshCreds.refreshToken)
    record.providers[connId].refreshToken = freshCreds.refreshToken;

  if (freshCreds.expiresIn) {
    record.providers[connId].expiresAt = new Date(
      Date.now() + freshCreds.expiresIn * 1000
    ).toISOString();
    record.providers[connId].expiresIn = freshCreds.expiresIn;
  }

  record.providers[connId].updatedAt = new Date().toISOString();

  await saveMachineData(deviceId, record, env);
  log.debug("EMBEDDINGS_TOKEN", `credentials updated | ${connId}`);
}
