import { getModelInfoCore } from "open-sse/services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import {
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil,
  getEarliestRateLimitedUntil,
  formatRetryAfter
} from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { getComboModelsFromData, handleComboChat } from "open-sse/services/combo.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { parseApiKey, extractBearerToken } from "../utils/apiKey.js";
import { getMachineData, saveMachineData } from "../services/storage.js";

// Refresh tokens this many ms before they actually expire
const EXPIRY_LEAD_TIME_MS = 5 * 60 * 1000;

// Resolve model aliases and provider info for the given device
async function resolveModelInfo(rawModel, deviceId, env) {
  const stored = await getMachineData(deviceId, env);
  return getModelInfoCore(rawModel, stored?.modelAliases ?? {});
}

/**
 * Entry point for chat requests.
 *
 * Supports two authentication patterns:
 *   - Legacy: machineId in the URL path, key validated separately
 *   - Current: machineId embedded in the API key itself
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} ctx
 * @param {string|null} legacyDeviceId - device ID from URL segment, or null for key-embedded mode
 */
export async function handleChat(request, env, ctx, legacyDeviceId = null) {
  // Respond to CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  let deviceId = legacyDeviceId;

  // When no device ID comes from the URL, pull it out of the bearer token
  if (!deviceId) {
    const bearerKey = extractBearerToken(request);
    if (!bearerKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");

    const keyPayload = await parseApiKey(bearerKey);
    if (!keyPayload) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key format");

    if (!keyPayload.isNewFormat || !keyPayload.machineId) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "API key does not contain machineId. Use /{machineId}/v1/... endpoint for old format keys."
      );
    }

    deviceId = keyPayload.machineId;
  }

  const keyIsValid = await verifyRequestKey(request, deviceId, env);
  if (!keyIsValid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");

  let requestBody;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const requestedModel = requestBody.model;
  log.info("CHAT", `${deviceId} | ${requestedModel}`, { stream: requestBody.stream !== false });

  if (!requestedModel) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  // Check whether the requested model is a combo (fan-out across multiple real models)
  const machineRecord = await getMachineData(deviceId, env);
  const expandedCombo = getComboModelsFromData(requestedModel, machineRecord?.combos ?? []);

  if (expandedCombo) {
    log.info("COMBO", `"${requestedModel}" with ${expandedCombo.length} models`);
    return handleComboChat({
      body: requestBody,
      models: expandedCombo,
      handleSingleModel: (singleBody, singleModel) =>
        dispatchSingleModel(singleBody, singleModel, deviceId, env),
      log
    });
  }

  return dispatchSingleModel(requestBody, requestedModel, deviceId, env);
}

// Handles a chat request to one specific model, with fallback across provider accounts
async function dispatchSingleModel(body, rawModel, deviceId, env) {
  const modelInfo = await resolveModelInfo(rawModel, deviceId, env);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("MODEL", `${provider.toUpperCase()} | ${model}`);

  // Track which account we last excluded and what error it returned
  let skippedAccountId = null;
  let previousErrorMsg = null;
  let previousStatusCode = null;

  for (;;) {
    const account = await pickProviderAccount(deviceId, provider, env, skippedAccountId);

    if (!account || account.allRateLimited) {
      if (account?.allRateLimited) {
        const waitSec = Math.ceil(
          (new Date(account.retryAfter).getTime() - Date.now()) / 1000
        );
        const errorDetail = previousErrorMsg ?? account.lastError ?? "Unavailable";
        const fullMsg = `[${provider}/${model}] ${errorDetail} (${account.retryAfterHuman})`;
        const responseStatus =
          previousStatusCode ?? Number(account.lastErrorCode) ?? HTTP_STATUS.SERVICE_UNAVAILABLE;

        log.warn("CHAT", `${provider.toUpperCase()} | ${fullMsg}`);
        return new Response(JSON.stringify({ error: { message: fullMsg } }), {
          status: responseStatus,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.max(waitSec, 1))
          }
        });
      }

      // No accounts exist for this provider at all
      if (!skippedAccountId) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }

      log.warn("CHAT", `${provider.toUpperCase()} | no more accounts`);
      return new Response(
        JSON.stringify({ error: previousErrorMsg ?? "All accounts unavailable" }),
        {
          status: previousStatusCode ?? HTTP_STATUS.SERVICE_UNAVAILABLE,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    log.debug("CHAT", `account=${account.id}`, { provider });

    const liveAccount = await maybeRefreshToken(deviceId, provider, account, env);

    const outcome = await handleChatCore({
      body,
      modelInfo: { provider, model },
      credentials: liveAccount,
      log,
      onCredentialsRefreshed: async (freshCreds) => {
        await persistTokenUpdate(deviceId, account.id, freshCreds, env);
      },
      onRequestSuccess: async () => {
        // Only write back if the account was previously marked as having trouble
        await resetAccountStatus(deviceId, account.id, account, env);
      }
    });

    if (outcome.success) return outcome.response;

    const { shouldFallback } = checkFallbackError(outcome.status, outcome.error, 0, {
      provider,
      accountId: account.id,
    });

    if (shouldFallback) {
      log.warn("FALLBACK", `${provider.toUpperCase()} | ${account.id} | ${outcome.status}`);
      await flagAccountDown(deviceId, account.id, outcome.status, outcome.error, env, outcome.resetsAtMs);
      skippedAccountId = account.id;
      previousErrorMsg = outcome.error;
      previousStatusCode = outcome.status;
      continue;
    }

    return outcome.response;
  }
}

// Checks token expiry and refreshes if we're within the lead-time window
async function maybeRefreshToken(deviceId, provider, account, env) {
  if (!account.expiresAt) return account;

  const expiryTs = new Date(account.expiresAt).getTime();
  const timeLeft = expiryTs - Date.now();
  if (timeLeft >= EXPIRY_LEAD_TIME_MS) return account;

  log.debug("TOKEN", `${provider.toUpperCase()} | expiring, refreshing`);

  const refreshed = await refreshTokenByProvider(provider, account);
  if (!refreshed?.accessToken) return account;

  await persistTokenUpdate(deviceId, account.id, refreshed, env);

  return {
    ...account,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? account.refreshToken,
    expiresAt: refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      : account.expiresAt
  };
}

// Validates the bearer token in the request against stored keys for this device
async function verifyRequestKey(request, deviceId, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const submittedKey = authHeader.slice(7);
  const stored = await getMachineData(deviceId, env);
  return stored?.apiKeys?.some((entry) => entry.key === submittedKey) ?? false;
}

// Finds the best available (non-rate-limited, active) account for a provider
async function pickProviderAccount(deviceId, provider, env, excludeId = null) {
  const stored = await getMachineData(deviceId, env);
  if (!stored?.providers) return null;

  const eligible = Object.entries(stored.providers)
    .filter(([connId, conn]) => {
      if (conn.provider !== provider) return false;
      if (!conn.isActive) return false;
      if (excludeId && connId === excludeId) return false;
      if (isAccountUnavailable(conn.rateLimitedUntil)) return false;
      return true;
    })
    .sort(([, a], [, b]) => (a.priority ?? 999) - (b.priority ?? 999));

  if (eligible.length > 0) {
    const [chosenId, chosenConn] = eligible[0];
    return {
      id: chosenId,
      apiKey: chosenConn.apiKey,
      accessToken: chosenConn.accessToken,
      refreshToken: chosenConn.refreshToken,
      expiresAt: chosenConn.expiresAt,
      projectId: chosenConn.projectId,
      copilotToken: chosenConn.providerSpecificData?.copilotToken,
      providerSpecificData: chosenConn.providerSpecificData,
      status: chosenConn.status,
      lastError: chosenConn.lastError,
      rateLimitedUntil: chosenConn.rateLimitedUntil
    };
  }

  // Nothing eligible — check whether all accounts are rate-limited or simply absent
  const allActive = Object.values(stored.providers).filter(
    (c) => c.provider === provider && c.isActive
  );
  const soonestUnlock = getEarliestRateLimitedUntil(allActive);

  if (!soonestUnlock) return null;

  const rateLimited = allActive
    .filter((c) => c.rateLimitedUntil && new Date(c.rateLimitedUntil).getTime() > Date.now())
    .sort((a, b) => new Date(a.rateLimitedUntil) - new Date(b.rateLimitedUntil));

  const soonest = rateLimited[0];
  return {
    allRateLimited: true,
    retryAfter: soonestUnlock,
    retryAfterHuman: formatRetryAfter(soonestUnlock),
    lastError: soonest?.lastError ?? null,
    lastErrorCode: soonest?.errorCode ?? null
  };
}

// Marks an account as unavailable and persists the error/cooldown info
async function flagAccountDown(deviceId, accountId, httpStatus, errorMsg, env, preciseResetMs = null) {
  const stored = await getMachineData(deviceId, env);
  if (!stored?.providers?.[accountId]) return;

  const existing = stored.providers[accountId];
  const currentBackoff = existing.backoffLevel ?? 0;

  let cooldownMs, updatedBackoff;
  if (preciseResetMs && preciseResetMs > Date.now()) {
    // Provider told us exactly when it resets — use that, capped at the global max
    cooldownMs = Math.min(preciseResetMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    updatedBackoff = 0;
  } else {
    ({ cooldownMs, newBackoffLevel: updatedBackoff } = checkFallbackError(httpStatus, errorMsg, currentBackoff));
  }

  const blockedUntil = getUnavailableUntil(cooldownMs);
  const truncatedReason =
    typeof errorMsg === "string" ? errorMsg.slice(0, 100) : "Provider error";
  const now = new Date().toISOString();

  Object.assign(stored.providers[accountId], {
    rateLimitedUntil: blockedUntil,
    status: "unavailable",
    lastError: truncatedReason,
    errorCode: httpStatus ?? null,
    lastErrorAt: now,
    backoffLevel: updatedBackoff ?? currentBackoff,
    updatedAt: now
  });

  await saveMachineData(deviceId, stored, env);
  log.warn("ACCOUNT", `${accountId} | unavailable until ${blockedUntil} (backoff=${updatedBackoff ?? currentBackoff})`);
}

// Clears error state from an account after a successful request
async function resetAccountStatus(deviceId, accountId, snapshot, env) {
  // Skip the write if the account looked clean going into this request
  const hadProblem =
    snapshot.status === "unavailable" || snapshot.lastError || snapshot.rateLimitedUntil;

  if (!hadProblem) return;

  const stored = await getMachineData(deviceId, env);
  if (!stored?.providers?.[accountId]) return;

  Object.assign(stored.providers[accountId], {
    status: "active",
    lastError: null,
    lastErrorAt: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
    updatedAt: new Date().toISOString()
  });

  await saveMachineData(deviceId, stored, env);
  log.info("ACCOUNT", `${accountId} | error cleared`);
}

// Writes refreshed token data back to persistent storage
async function persistTokenUpdate(deviceId, accountId, freshCreds, env) {
  const stored = await getMachineData(deviceId, env);
  if (!stored?.providers?.[accountId]) return;

  stored.providers[accountId].accessToken = freshCreds.accessToken;

  if (freshCreds.refreshToken) {
    stored.providers[accountId].refreshToken = freshCreds.refreshToken;
  }

  if (freshCreds.expiresIn) {
    stored.providers[accountId].expiresAt = new Date(
      Date.now() + freshCreds.expiresIn * 1000
    ).toISOString();
    stored.providers[accountId].expiresIn = freshCreds.expiresIn;
  }

  stored.providers[accountId].updatedAt = new Date().toISOString();

  await saveMachineData(deviceId, stored, env);
  log.debug("TOKEN", `credentials updated | ${accountId}`);
}
