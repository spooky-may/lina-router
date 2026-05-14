import crypto from "crypto";

import { getSettings, updateSettings } from "@/lib/localDb";
import { getCachedPassword, initDbHooks, loadEncryptedPassword } from "@/mitm/manager";

import {
  isCloudflaredRunning,
  killCloudflared,
  setUnexpectedExitHandler,
  spawnQuickTunnel,
} from "./cloudflared.js";
import { probeUrlAlive, waitForHealth } from "./networkProbe.js";
import { generateShortId, loadState, saveState } from "./state.js";
import {
  isTailscaleLoggedIn,
  isTailscaleRunning,
  isTailscaleRunningStrict,
  provisionCert,
  startDaemonWithPassword,
  startFunnel,
  startLogin,
  stopFunnel,
} from "./tailscale.js";

// Wire DB read/write callbacks into the password vault as soon as this module loads.
initDbHooks(getSettings, updateSettings);

/* ────────────────────────────────────────────────────────────────────────────
   Configuration constants
   ──────────────────────────────────────────────────────────────────────────── */

const REMOTE_API_BASE = process.env.TUNNEL_WORKER_URL || "https://LINA Router.com";
const HOST_FINGERPRINT_PEPPER = "LINA Router-tunnel-salt";
const REACHABLE_CACHE_LIFESPAN_MS = 30_000;

/* ────────────────────────────────────────────────────────────────────────────
   Per-service runtime descriptors

   Cloudflare tunnel and Tailscale funnel run independently of one another, so
   each owns its own descriptor (cancel flag, spawn lock, port, last restart).
   ──────────────────────────────────────────────────────────────────────────── */

const createServiceDescriptor = () => ({
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
});

const tunnelSvc = createServiceDescriptor();
const tailscaleSvc = createServiceDescriptor();

const createReachableSlot = () => ({
  value: false,
  url: null,
  fetchedAt: 0,
  refreshing: false,
});

// Background reachability cache — the UI reads it to know if the public URL is
// genuinely serving requests, not merely that the cloudflared/tailscaled
// process is alive.
const tunnelReachable = createReachableSlot();
const tailscaleReachable = createReachableSlot();

/* ────────────────────────────────────────────────────────────────────────────
   Public service accessors / state flags
   ──────────────────────────────────────────────────────────────────────────── */

export function getTunnelService() {
  return tunnelSvc;
}

export function getTailscaleService() {
  return tailscaleSvc;
}

export function isTunnelManuallyDisabled() {
  return tunnelSvc.cancelToken.cancelled;
}

export function isTunnelReconnecting() {
  return tunnelSvc.spawnInProgress;
}

export function isTailscaleReconnecting() {
  return tailscaleSvc.spawnInProgress;
}

/* ────────────────────────────────────────────────────────────────────────────
   Reachability cache helpers
   ──────────────────────────────────────────────────────────────────────────── */

function scheduleReachableRefresh(slot, url) {
  if (slot.refreshing) return;

  if (!url) {
    slot.value = false;
    slot.url = null;
    slot.fetchedAt = Date.now();
    return;
  }

  slot.refreshing = true;
  probeUrlAlive(url)
    .then((ok) => {
      slot.value = ok;
    })
    .catch(() => {
      slot.value = false;
    })
    .finally(() => {
      slot.url = url;
      slot.fetchedAt = Date.now();
      slot.refreshing = false;
    });
}

function readReachable(slot, url) {
  // Whenever the target URL changes, drop the cached result immediately.
  if (slot.url !== url) {
    slot.value = false;
    slot.fetchedAt = 0;
  }

  const isStale = Date.now() - slot.fetchedAt > REACHABLE_CACHE_LIFESPAN_MS;
  if (isStale) scheduleReachableRefresh(slot, url);

  return slot.value;
}

/* ────────────────────────────────────────────────────────────────────────────
   Misc utilities
   ──────────────────────────────────────────────────────────────────────────── */

function getMachineId() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const seed = machineIdSync();
    return crypto
      .createHash("sha256")
      .update(seed + HOST_FINGERPRINT_PEPPER)
      .digest("hex")
      .substring(0, 16);
  } catch (e) {
    // node-machine-id unavailable → fall back to a one-shot random identifier.
    return crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  }
}

function throwIfCancelled(token, label) {
  if (token.cancelled) throw new Error(`${label} cancelled`);
}

function buildPublicUrl(shortId) {
  return `https://r${shortId}.LINA Router.com`;
}

async function registerTunnelUrl(shortId, tunnelUrl) {
  await fetch(`${REMOTE_API_BASE}/api/tunnel/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortId, tunnelUrl }),
  });
}

function primeReachableHit(slot, url) {
  slot.value = true;
  slot.url = url;
  slot.fetchedAt = Date.now();
}

function clearReachable(slot) {
  slot.value = false;
  slot.url = null;
  slot.fetchedAt = Date.now();
}

/* ────────────────────────────────────────────────────────────────────────────
   Cloudflare Tunnel — public API
   ──────────────────────────────────────────────────────────────────────────── */

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;

  const state = loadState();
  const shortId = state?.shortId || "";
  const tunnelUrl = state?.tunnelUrl || "";
  const publicUrl = shortId ? buildPublicUrl(shortId) : "";

  // Lazy probe: if the user disabled the tunnel, don't touch the PID table.
  const running = settingsEnabled ? isCloudflaredRunning() : false;
  // Reachability comes from the background probe so we never block the caller.
  const reachable =
    settingsEnabled && running ? readReachable(tunnelReachable, tunnelUrl) : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    shortId,
    publicUrl,
    running,
    reachable,
  };
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");

  tunnelSvc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);
  killCloudflared(tunnelSvc.activeLocalPort);

  const state = loadState();
  if (state) {
    saveState({ shortId: state.shortId, machineId: state.machineId, tunnelUrl: null });
  }

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "" });
  clearReachable(tunnelReachable);

  return { success: true };
}

export async function enableTunnel(localPort = 20128) {
  console.log(`[Tunnel] enable start (port=${localPort})`);

  tunnelSvc.cancelToken = { cancelled: false };
  tunnelSvc.activeLocalPort = localPort;
  tunnelSvc.spawnInProgress = true;
  const token = tunnelSvc.cancelToken;

  try {
    // Fast path: cloudflared is already running and its URL is still alive — reuse it.
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && (await probeUrlAlive(existing.tunnelUrl))) {
        const publicUrl = buildPublicUrl(existing.shortId);
        console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
        return {
          success: true,
          tunnelUrl: existing.tunnelUrl,
          shortId: existing.shortId,
          publicUrl,
          alreadyRunning: true,
        };
      }
    }

    // Otherwise: kill anything stale and start from a clean slate.
    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token, "tunnel");

    const machineId = getMachineId();
    const priorState = loadState();
    const shortId = priorState?.shortId || generateShortId();

    // cloudflared may emit a new URL mid-session (e.g. after reconnection);
    // persist + re-register every time it does.
    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      await registerTunnelUrl(shortId, url);
      saveState({ shortId, machineId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token, "tunnel");

    const publicUrl = buildPublicUrl(shortId);
    await registerTunnelUrl(shortId, tunnelUrl);
    saveState({ shortId, machineId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });
    console.log(`[Tunnel] registered shortId=${shortId} publicUrl=${publicUrl}`);

    // Health-check the *direct* trycloudflare URL first — the worker route can
    // produce a stale CDN hit that masks an unhealthy origin.
    await waitForHealth(tunnelUrl, token);
    console.log("[Tunnel] direct URL healthy");

    // Then confirm the LINA Router.com hostname resolves and serves the same.
    await waitForHealth(publicUrl, token);
    console.log("[Tunnel] public URL healthy");

    // Pre-seed the reachable cache so the dashboard reflects "up" without delay.
    primeReachableHit(tunnelReachable, tunnelUrl);

    console.log("[Tunnel] enable success");
    return { success: true, tunnelUrl, shortId, publicUrl };
  } catch (e) {
    console.error(`[Tunnel] enable error: ${e.message}`);
    throw e;
  } finally {
    tunnelSvc.spawnInProgress = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Tailscale Funnel — public API
   ──────────────────────────────────────────────────────────────────────────── */

export async function getTailscaleStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tailscaleEnabled === true;
  const tunnelUrl = settings.tailscaleUrl || "";

  // While the funnel is disabled, skip every probe. A logged-out daemon (e.g.
  // the device was deleted in the admin console) must short-circuit `running`.
  const loggedIn = settingsEnabled ? isTailscaleLoggedIn() : false;
  const running = loggedIn ? isTailscaleRunning() : false;

  // Reachability uses the same background-cache contract as the cloudflared path.
  const reachable =
    settingsEnabled && running ? readReachable(tailscaleReachable, tunnelUrl) : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    running,
    loggedIn,
    reachable,
  };
}

export async function disableTailscale() {
  console.log("[Tailscale] disable");

  tailscaleSvc.cancelToken.cancelled = true;
  stopFunnel();
  await updateSettings({ tailscaleEnabled: false, tailscaleUrl: "" });
  clearReachable(tailscaleReachable);

  return { success: true };
}

export async function enableTailscale(localPort = 20128) {
  console.log(`[Tailscale] enable start (port=${localPort})`);

  tailscaleSvc.cancelToken = { cancelled: false };
  tailscaleSvc.activeLocalPort = localPort;
  tailscaleSvc.spawnInProgress = true;
  const token = tailscaleSvc.cancelToken;

  try {
    // Step 1 — ensure the daemon is up. We may need a sudo password on Linux/macOS;
    // pull whatever the password vault has cached (or stored encrypted on disk).
    const sudoPass = getCachedPassword() || (await loadEncryptedPassword()) || "";
    await startDaemonWithPassword(sudoPass);
    console.log("[Tailscale] daemon ready");
    throwIfCancelled(token, "tailscale");

    // Step 2 — derive the funnel hostname from our persistent shortId.
    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();
    const tsHostname = shortId;

    // Step 3 — confirm we're authenticated; if not, trigger the OAuth flow.
    const loggedIn = isTailscaleLoggedIn();
    console.log(`[Tailscale] loggedIn=${loggedIn}`);

    if (!loggedIn) {
      const loginResult = await startLogin(tsHostname);
      if (loginResult.authUrl) {
        console.log(`[Tailscale] needs login, authUrl=${loginResult.authUrl}`);
        return { success: false, needsLogin: true, authUrl: loginResult.authUrl };
      }
      console.log("[Tailscale] login resolved alreadyLoggedIn");
    }
    throwIfCancelled(token, "tailscale");

    // Step 4 — restart the funnel cleanly.
    stopFunnel();

    let result;
    try {
      console.log("[Tailscale] starting funnel");
      result = await startFunnel(localPort);
    } catch (e) {
      console.error(`[Tailscale] funnel error: ${e.message}`);
      // If the daemon claims it's not logged in / not ready, transparently
      // surface the auth URL instead of bubbling a hard error to the user.
      const needsLogin = /NoState|unexpected state|not logged in|Logged ?out|NeedsLogin/i.test(
        e.message || ""
      );
      if (needsLogin) {
        console.log("[Tailscale] retry via startLogin");
        const loginResult = await startLogin(tsHostname);
        if (loginResult.authUrl) {
          return { success: false, needsLogin: true, authUrl: loginResult.authUrl };
        }
      }
      throw e;
    }
    throwIfCancelled(token, "tailscale");

    if (result.funnelNotEnabled) {
      console.log(`[Tailscale] funnel not enabled, enableUrl=${result.enableUrl}`);
      return { success: false, funnelNotEnabled: true, enableUrl: result.enableUrl };
    }

    // Strict re-probe: bypass the cached login flag so a freshly-deleted device
    // gets caught here instead of failing silently later.
    if (!isTailscaleLoggedIn() || !isTailscaleRunningStrict()) {
      console.error("[Tailscale] strict probe failed (device removed?)");
      stopFunnel();
      return {
        success: false,
        error: "Tailscale not connected. Device may have been removed. Please re-login.",
      };
    }

    await updateSettings({ tailscaleEnabled: true, tailscaleUrl: result.tunnelUrl });
    console.log(`[Tailscale] funnel up: ${result.tunnelUrl}`);

    // Step 5 — provision a Let's Encrypt cert so the funnel can serve HTTPS.
    // Best-effort: cert provisioning failures shouldn't tear down a working funnel.
    const hostname = new URL(result.tunnelUrl).hostname;
    await provisionCert(hostname);

    // Step 6 — verify /api/health responds. A timeout here is non-fatal because
    // tailscale DNS can still be propagating; the watchdog will keep retrying.
    let reachableNow = false;
    try {
      await waitForHealth(result.tunnelUrl, token);
      reachableNow = true;
    } catch (he) {
      if (!he.message.startsWith("Health check timeout")) throw he;
      console.warn(`[Tailscale] health check timed out, will retry via watchdog`);
    }

    if (reachableNow) primeReachableHit(tailscaleReachable, result.tunnelUrl);

    console.log(`[Tailscale] enable success (reachable=${reachableNow})`);
    return { success: true, tunnelUrl: result.tunnelUrl };
  } catch (e) {
    console.error(`[Tailscale] enable error: ${e.message}`);
    throw e;
  } finally {
    tailscaleSvc.spawnInProgress = false;
  }
}
