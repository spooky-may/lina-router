/**
 * Provider health monitor — periodically probes upstream AI providers and
 * tracks rolling availability stats. The router consults this monitor before
 * routing to a provider; the dashboard exposes the same data for operator
 * visibility.
 *
 * Design notes:
 *   - Each provider has its own circuit-breaker state machine (closed → open →
 *     half-open). Once a breaker opens, traffic is paused and a single probe
 *     request is issued every `RECOVERY_PROBE_MS`. A successful probe trips
 *     the breaker back to half-open; a second successful real request closes
 *     it fully.
 *   - All probe traffic is rate-capped to one in-flight per provider. We do
 *     not block the caller — `shouldRoute()` returns synchronously based on
 *     the most recent in-memory snapshot.
 *   - History is kept as a fixed-size sample array per provider for percentile
 *     calculation, not a streaming sketch (small N, deterministic memory).
 */

import { EventEmitter } from "events";

const DEFAULTS = Object.freeze({
  WINDOW_SAMPLES: 50,
  FAILURE_RATIO_TO_OPEN: 0.5,
  CONSECUTIVE_FAILURES_TO_OPEN: 5,
  RECOVERY_PROBE_MS: 30_000,
  PROBE_TIMEOUT_MS: 8_000,
  HALF_OPEN_SUCCESS_TO_CLOSE: 2,
});

const STATE = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

/**
 * Tracks the recent outcomes for a single provider and decides when the
 * breaker should change state.
 */
class ProviderHealth {
  constructor(providerId, options) {
    this.providerId = providerId;
    this.options = options;

    this.state = STATE.CLOSED;
    this.lastTransitionAt = Date.now();
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;

    // Rolling window of {ok, latencyMs, ts} samples
    this._samples = [];
  }

  pushOutcome(ok, latencyMs) {
    const sample = { ok, latencyMs, ts: Date.now() };
    this._samples.push(sample);
    if (this._samples.length > this.options.WINDOW_SAMPLES) {
      this._samples.shift();
    }

    if (ok) {
      this.consecutiveSuccesses += 1;
      this.consecutiveFailures = 0;
      this.lastSuccessAt = sample.ts;
    } else {
      this.consecutiveFailures += 1;
      this.consecutiveSuccesses = 0;
      this.lastFailureAt = sample.ts;
    }

    return this._evaluateTransitions();
  }

  _evaluateTransitions() {
    const prev = this.state;

    if (this.state === STATE.CLOSED) {
      if (this._shouldOpen()) this._transition(STATE.OPEN);
    } else if (this.state === STATE.HALF_OPEN) {
      if (this.consecutiveFailures > 0) {
        this._transition(STATE.OPEN);
      } else if (
        this.consecutiveSuccesses >= this.options.HALF_OPEN_SUCCESS_TO_CLOSE
      ) {
        this._transition(STATE.CLOSED);
      }
    }

    return prev !== this.state ? this.state : null;
  }

  _shouldOpen() {
    if (this.consecutiveFailures >= this.options.CONSECUTIVE_FAILURES_TO_OPEN) {
      return true;
    }
    if (this._samples.length >= this.options.WINDOW_SAMPLES) {
      const failures = this._samples.filter((s) => !s.ok).length;
      const ratio = failures / this._samples.length;
      if (ratio >= this.options.FAILURE_RATIO_TO_OPEN) return true;
    }
    return false;
  }

  // Called by the monitor's probe scheduler when an open breaker is due for
  // a recovery probe. Transitions to half-open optimistically; the next
  // pushOutcome will either confirm or revert.
  prepareForRecoveryProbe() {
    if (this.state !== STATE.OPEN) return false;
    this._transition(STATE.HALF_OPEN);
    return true;
  }

  _transition(next) {
    this.state = next;
    this.lastTransitionAt = Date.now();
    if (next === STATE.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  latencyPercentile(p) {
    if (this._samples.length === 0) return null;
    const latencies = this._samples
      .filter((s) => s.ok && typeof s.latencyMs === "number")
      .map((s) => s.latencyMs)
      .sort((a, b) => a - b);
    if (latencies.length === 0) return null;
    const rank = Math.min(
      latencies.length - 1,
      Math.floor((p / 100) * latencies.length)
    );
    return latencies[rank];
  }

  summary() {
    const okCount = this._samples.filter((s) => s.ok).length;
    const total = this._samples.length;
    return {
      providerId: this.providerId,
      state: this.state,
      lastTransitionAt: this.lastTransitionAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      samples: total,
      successRatio: total === 0 ? null : okCount / total,
      p50LatencyMs: this.latencyPercentile(50),
      p95LatencyMs: this.latencyPercentile(95),
    };
  }
}

class HealthMonitor extends EventEmitter {
  constructor({ probeFn, options } = {}) {
    super();
    this.options = { ...DEFAULTS, ...(options || {}) };
    this.providers = new Map(); // providerId → ProviderHealth
    this.probeFn = probeFn || null;
    this._probeTimer = null;
    this._inFlightProbes = new Set();
  }

  _ensure(providerId) {
    let entry = this.providers.get(providerId);
    if (!entry) {
      entry = new ProviderHealth(providerId, this.options);
      this.providers.set(providerId, entry);
    }
    return entry;
  }

  // Public: synchronous router decision. True = caller may use this provider.
  shouldRoute(providerId) {
    const entry = this.providers.get(providerId);
    if (!entry) return true;            // unknown providers are assumed healthy
    return entry.state !== STATE.OPEN;
  }

  // Public: caller reports the outcome of a real request.
  recordOutcome(providerId, ok, latencyMs) {
    const entry = this._ensure(providerId);
    const transition = entry.pushOutcome(ok, latencyMs);
    if (transition) {
      this.emit("breakerTransition", {
        providerId,
        state: transition,
        at: entry.lastTransitionAt,
      });
    }
  }

  snapshot() {
    const result = {};
    for (const [id, entry] of this.providers.entries()) {
      result[id] = entry.summary();
    }
    return result;
  }

  start() {
    if (this._probeTimer || !this.probeFn) return;
    this._probeTimer = setInterval(
      () => this._tickRecoveryProbes(),
      this.options.RECOVERY_PROBE_MS
    );
    if (typeof this._probeTimer.unref === "function") {
      this._probeTimer.unref();
    }
  }

  stop() {
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
  }

  async _tickRecoveryProbes() {
    for (const [providerId, entry] of this.providers.entries()) {
      if (entry.state !== STATE.OPEN) continue;
      if (this._inFlightProbes.has(providerId)) continue;

      this._inFlightProbes.add(providerId);
      entry.prepareForRecoveryProbe();

      const startedAt = Date.now();
      try {
        const probe = await Promise.race([
          Promise.resolve(this.probeFn(providerId)),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("probe timeout")), this.options.PROBE_TIMEOUT_MS)
          ),
        ]);
        const ok = probe === true || (probe && probe.ok === true);
        this.recordOutcome(providerId, ok, Date.now() - startedAt);
      } catch {
        this.recordOutcome(providerId, false, Date.now() - startedAt);
      } finally {
        this._inFlightProbes.delete(providerId);
      }
    }
  }
}

let _shared = null;

export function getHealthMonitor(opts) {
  if (!_shared) _shared = new HealthMonitor(opts || {});
  return _shared;
}

export function recordOutcome(providerId, ok, latencyMs) {
  return getHealthMonitor().recordOutcome(providerId, ok, latencyMs);
}

export function shouldRoute(providerId) {
  return getHealthMonitor().shouldRoute(providerId);
}

export function getHealthSnapshot() {
  return getHealthMonitor().snapshot();
}

export { STATE as BREAKER_STATE };
