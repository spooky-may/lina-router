import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../config/errorConfig.js";
import { recordEvent, EVENT_KIND } from "../../src/lib/analytics/eventTelemetry.js";
import { recordOutcome as recordHealthOutcome } from "../../src/lib/healthcheck/healthMonitor.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 *
 * When `meta.provider` is supplied, also emits a FALLBACK_TRIGGERED telemetry
 * event and records an unhealthy outcome for that provider's circuit breaker.
 * Status 429 additionally emits a RATE_LIMIT_HIT event. Callers that omit
 * `meta` are unaffected.
 *
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {object} [meta] - Optional: { provider, accountId }
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, meta = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  let outcome;

  outer: {
    for (const rule of ERROR_RULES) {
      // Text-based rule: match substring in error message
      if (rule.text && lowerError && lowerError.includes(rule.text)) {
        if (rule.backoff) {
          const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
          outcome = { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
          break outer;
        }
        outcome = { shouldFallback: true, cooldownMs: rule.cooldownMs };
        break outer;
      }

      // Status-based rule: match HTTP status code
      if (rule.status && rule.status === status) {
        if (rule.backoff) {
          const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
          outcome = { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
          break outer;
        }
        outcome = { shouldFallback: true, cooldownMs: rule.cooldownMs };
        break outer;
      }
    }

    // Default: transient cooldown for any unmatched error
    outcome = { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
  }

  // Emit telemetry only when caller provided provider context
  if (meta && meta.provider && outcome.shouldFallback) {
    recordEvent(EVENT_KIND.FALLBACK_TRIGGERED, {
      provider: meta.provider,
      accountId: meta.accountId,
      status,
      cooldownMs: outcome.cooldownMs,
    });
    if (status === 429) {
      recordEvent(EVENT_KIND.RATE_LIMIT_HIT, {
        provider: meta.provider,
        accountId: meta.accountId,
        backoffLevel: outcome.newBackoffLevel ?? backoffLevel,
      });
    }
    recordHealthOutcome(meta.provider, false, 0);
  }

  return outcome;
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 *
 * Also emits a REQUEST_OK telemetry event and records a healthy outcome
 * for the provider's circuit breaker when `meta.provider` is supplied.
 *
 * @param {object} account - Account object
 * @param {object} [meta] - Optional context: { provider, latencyMs }
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account, meta = null) {
  if (!account) return account;

  if (meta && meta.provider) {
    recordEvent(EVENT_KIND.REQUEST_OK, {
      provider: meta.provider,
      accountId: account.id,
      latencyMs: meta.latencyMs,
    });
    recordHealthOutcome(meta.provider, true, meta.latencyMs || 0);
  }

  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 *
 * Emits FALLBACK_TRIGGERED + (when status is 429) RATE_LIMIT_HIT telemetry,
 * and records an unhealthy outcome for the provider's circuit breaker when
 * `meta.provider` is supplied. Existing callers without `meta` are unaffected.
 *
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @param {object} [meta] - Optional context: { provider, latencyMs }
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText, meta = null) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  if (meta && meta.provider) {
    recordEvent(EVENT_KIND.FALLBACK_TRIGGERED, {
      provider: meta.provider,
      accountId: account.id,
      status,
      cooldownMs,
    });
    if (status === 429) {
      recordEvent(EVENT_KIND.RATE_LIMIT_HIT, {
        provider: meta.provider,
        accountId: account.id,
        backoffLevel: newBackoffLevel ?? backoffLevel,
      });
    }
    recordHealthOutcome(meta.provider, false, meta.latencyMs || 0);
  }

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
