import path from "path";
import fs from "fs";
import os from "os";
import { spawn, exec, execSync } from "child_process";
import { promisify } from "util";
import { DATA_DIR } from "@/lib/dataDir.js";
import { execWithPassword } from "@/mitm/dns/dnsConfig";
import { saveTailscalePid, loadTailscalePid, clearTailscalePid } from "./state.js";

const runAsync = promisify(exec);

// Platform detection flags
const onWindows = os.platform() === "win32";
const onMac = os.platform() === "darwin";
const onLinux = os.platform() === "linux";

// Paths for bundled and system-installed binaries
const binariesDir = path.join(DATA_DIR, "bin");
const bundledBin = path.join(binariesDir, onWindows ? "tailscale.exe" : "tailscale");
const tsDataDir = path.join(DATA_DIR, "tailscale");

// Socket used for userspace daemon (root not required in this mode)
export const TAILSCALE_SOCKET = path.join(tsDataDir, "tailscaled.sock");
const socketArgs = onWindows ? [] : ["--socket", TAILSCALE_SOCKET];

// Known fixed install location on Windows
const WIN_SYSTEM_BIN = "C:\\Program Files\\Tailscale\\tailscale.exe";

// Candidate paths for system-wide installs on Unix
const UNIX_SEARCH_PATHS = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
];

// Append common dirs so child processes can find tools regardless of login shell
const ENRICHED_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`;

// ── Cache layer — all three caches share the same shape ──────────────────────
const CACHE_MAX_AGE_MS = 10000;
const EXEC_DEADLINE_MS = 1500;

const binaryCache  = { val: undefined, ts: 0, busy: false };
const activeCache  = { val: false,     ts: 0, busy: false };
const urlCache     = { val: null, port: null, ts: 0, busy: false };

// ── Binary resolution ─────────────────────────────────────────────────────────

/** Probe the filesystem synchronously for a known-good tailscale binary. */
function resolveBinSync() {
  if (fs.existsSync(bundledBin)) return bundledBin;
  if (onWindows && fs.existsSync(WIN_SYSTEM_BIN)) return WIN_SYSTEM_BIN;
  if (!onWindows) {
    const hit = UNIX_SEARCH_PATHS.find((p) => fs.existsSync(p));
    return hit || null;
  }
  return null;
}

/** Kick off a background `which`/`where` to find tailscale on $PATH. */
function scheduleBinaryRefresh() {
  if (binaryCache.busy) return;
  binaryCache.busy = true;
  runAsync("which tailscale 2>/dev/null || where tailscale 2>nul", {
    windowsHide: true,
    timeout: EXEC_DEADLINE_MS,
  })
    .then(({ stdout }) => {
      const located = stdout.trim();
      binaryCache.val = located || resolveBinSync();
    })
    .catch(() => {
      binaryCache.val = resolveBinSync();
    })
    .finally(() => {
      binaryCache.ts = Date.now();
      binaryCache.busy = false;
    });
}

/**
 * Return the tailscale binary path without blocking the event loop.
 * A background refresh runs whenever the cached value is older than CACHE_MAX_AGE_MS.
 */
function locateBin() {
  if (Date.now() - binaryCache.ts > CACHE_MAX_AGE_MS) scheduleBinaryRefresh();

  // First access: do a quick synchronous filesystem probe
  if (binaryCache.val === undefined) {
    if (fs.existsSync(bundledBin)) {
      binaryCache.val = bundledBin;
    } else if (onWindows && fs.existsSync(WIN_SYSTEM_BIN)) {
      binaryCache.val = WIN_SYSTEM_BIN;
    } else if (!onWindows) {
      binaryCache.val = UNIX_SEARCH_PATHS.find((p) => fs.existsSync(p)) || null;
    } else {
      binaryCache.val = null;
    }
  }

  return binaryCache.val;
}

export function isTailscaleInstalled() {
  return locateBin() !== null;
}

/** Prepend socket args so every CLI call uses our custom socket. */
function buildArgs(...rest) {
  return [...socketArgs, ...rest];
}

// ── Login / connectivity probes ───────────────────────────────────────────────

export function isTailscaleLoggedIn() {
  const bin = locateBin();
  if (!bin) return false;
  try {
    const raw = execSync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: ENRICHED_PATH },
      timeout: 5000,
    });
    const parsed = JSON.parse(raw);
    // Both BackendState=Running AND Self.Online=true are required
    return parsed.BackendState === "Running" && parsed.Self?.Online === true;
  } catch {
    return false;
  }
}

// ── Funnel running state (cached) ─────────────────────────────────────────────

/** Asynchronously refresh whether the funnel is active. */
function refreshActiveState() {
  if (activeCache.busy) return;
  const bin = locateBin();
  if (!bin) {
    activeCache.val = false;
    activeCache.ts = Date.now();
    return;
  }
  activeCache.busy = true;
  runAsync(`"${bin}" ${socketArgs.join(" ")} funnel status --json`, {
    windowsHide: true,
    timeout: EXEC_DEADLINE_MS,
  })
    .then(({ stdout }) => {
      try {
        const data = JSON.parse(stdout);
        activeCache.val = Object.keys(data.AllowFunnel || {}).length > 0;
      } catch {
        activeCache.val = false;
      }
    })
    .catch(() => {
      activeCache.val = false;
    })
    .finally(() => {
      activeCache.ts = Date.now();
      activeCache.busy = false;
    });
}

/** Non-blocking: returns last known funnel state and triggers a background refresh if stale. */
export function isTailscaleRunning() {
  if (Date.now() - activeCache.ts > CACHE_MAX_AGE_MS) refreshActiveState();
  return activeCache.val;
}

/**
 * Blocking probe for user-triggered flows (connect / enable).
 * Waits at most EXEC_DEADLINE_MS; updates the shared cache as a side effect.
 */
export function isTailscaleRunningStrict() {
  const bin = locateBin();
  if (!bin) return false;
  try {
    const raw = execSync(
      `"${bin}" ${socketArgs.join(" ")} funnel status --json 2>/dev/null`,
      { encoding: "utf8", windowsHide: true, timeout: EXEC_DEADLINE_MS }
    );
    const data = JSON.parse(raw);
    const isActive = Object.keys(data.AllowFunnel || {}).length > 0;
    activeCache.val = isActive;
    activeCache.ts = Date.now();
    return isActive;
  } catch {
    return false;
  }
}

// ── Funnel URL (cached) ───────────────────────────────────────────────────────

/** Background fetch of the device DNS name for URL construction. */
function refreshUrlCache(targetPort) {
  if (urlCache.busy) return;
  const bin = locateBin();
  if (!bin) return;
  urlCache.busy = true;
  runAsync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
    windowsHide: true,
    timeout: EXEC_DEADLINE_MS,
  })
    .then(({ stdout }) => {
      try {
        const data = JSON.parse(stdout);
        const hostname = data.Self?.DNSName?.replace(/\.$/, "");
        urlCache.val = hostname ? `https://${hostname}` : null;
      } catch { /* retain previous */ }
    })
    .catch(() => { /* retain previous */ })
    .finally(() => {
      urlCache.port = targetPort;
      urlCache.ts = Date.now();
      urlCache.busy = false;
    });
}

/**
 * Synchronously derive the actual funnel URL from Self.DNSName.
 * Avoids the `-1` hostname-conflict suffix that `tailscale funnel` stdout can emit.
 */
function fetchFunnelUrlNow() {
  const bin = locateBin();
  if (!bin) return null;
  try {
    const raw = execSync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: ENRICHED_PATH },
      timeout: 5000,
    });
    const data = JSON.parse(raw);
    const hostname = data.Self?.DNSName?.replace(/\.$/, "");
    return hostname ? `https://${hostname}` : null;
  } catch {
    return null;
  }
}

/** Return the cached funnel URL, scheduling a refresh when stale or port changed. */
export function getTailscaleFunnelUrl(port) {
  if (Date.now() - urlCache.ts > CACHE_MAX_AGE_MS || urlCache.port !== port) {
    refreshUrlCache(port);
  }
  return urlCache.val;
}

// ── Installation ──────────────────────────────────────────────────────────────

/**
 * Install Tailscale for the current platform.
 *
 * macOS with Homebrew  → brew install tailscale
 * macOS without Homebrew → download .pkg, sudo installer
 * Linux               → pipe install.sh to sudo sh
 * Windows             → download MSI, elevate via PowerShell
 */
export async function installTailscale(sudoPassword, hostname, onProgress) {
  const emit = onProgress || (() => {});

  if (onWindows) {
    await doWindowsInstall(emit);
    return { success: true };
  }

  if (onMac) await doMacInstall(sudoPassword, emit);
  else await doLinuxInstall(sudoPassword, emit);

  emit("Starting daemon...");
  await startDaemonWithPassword(sudoPassword);
  emit("Logging in...");
  return startLogin(hostname);
}

function brewAvailable() {
  try {
    execSync("which brew", {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PATH: ENRICHED_PATH },
    });
    return true;
  } catch {
    return false;
  }
}

async function doMacInstall(sudoPassword, emit) {
  if (brewAvailable()) {
    emit("Installing via Homebrew...");
    await new Promise((resolve, reject) => {
      const proc = spawn("brew", ["install", "tailscale"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PATH: ENRICHED_PATH },
      });
      proc.stdout.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) emit(line);
      });
      proc.stderr.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) emit(line);
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`brew install failed (code ${code})`));
      });
      proc.on("error", reject);
    });
    return;
  }

  // Homebrew not available — use the official .pkg
  const downloadUrl = "https://pkgs.tailscale.com/stable/tailscale-latest.pkg";
  const localPkg = path.join(os.tmpdir(), "tailscale.pkg");

  emit("Downloading Tailscale package...");
  await new Promise((resolve, reject) => {
    const proc = spawn("curl", ["-fL", "--progress-bar", downloadUrl, "-o", localPkg], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) emit(line);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Download failed"));
    });
    proc.on("error", reject);
  });

  emit("Installing package...");
  await new Promise((resolve, reject) => {
    const proc = spawn("sudo", ["-S", "installer", "-pkg", localPkg, "-target", "/"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let errBuf = "";
    proc.stderr.on("data", (chunk) => { errBuf += chunk.toString(); });
    proc.stdout.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) emit(line);
    });
    proc.on("close", (code) => {
      try { execSync(`rm -f ${localPkg}`, { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
      if (code === 0) {
        resolve();
      } else {
        const reason =
          errBuf.includes("incorrect password") || errBuf.includes("Sorry")
            ? "Wrong sudo password"
            : errBuf || `Exit code ${code}`;
        reject(new Error(reason));
      }
    });
    proc.on("error", reject);
    proc.stdin.write(`${sudoPassword}\n`);
    proc.stdin.end();
  });
}

async function doLinuxInstall(sudoPassword, emit) {
  emit("Downloading install script...");
  return new Promise((resolve, reject) => {
    const fetcher = spawn("curl", ["-fsSL", "https://tailscale.com/install.sh"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let scriptBody = "";
    let fetchErr = "";
    fetcher.stdout.on("data", (chunk) => { scriptBody += chunk.toString(); });
    fetcher.stderr.on("data", (chunk) => { fetchErr += chunk.toString(); });
    fetcher.on("exit", (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error(`Failed to download install script: ${fetchErr}`));
      }
      emit("Running install script...");
      const runner = spawn("sudo", ["-S", "sh"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let runErr = "";
      runner.stdout.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) emit(line);
      });
      runner.stderr.on("data", (chunk) => { runErr += chunk.toString(); });
      runner.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const reason =
            runErr.includes("incorrect password") || runErr.includes("Sorry")
              ? "Wrong sudo password"
              : runErr || `Exit code ${code}`;
          reject(new Error(reason));
        }
      });
      runner.on("error", reject);
      runner.stdin.write(`${sudoPassword}\n`);
      runner.stdin.write(scriptBody);
      runner.stdin.end();
    });
    fetcher.on("error", reject);
  });
}

async function doWindowsInstall(emit) {
  const msiSource = "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi";
  const msiDest = path.join(os.tmpdir(), "tailscale-setup.msi");

  emit("Downloading Tailscale installer...");
  await new Promise((resolve, reject) => {
    const proc = spawn("curl.exe", ["-L", "-#", "-o", msiDest, msiSource], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let prevPct = "";
    proc.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      const m = txt.match(/(\d+\.\d)%/);
      if (m && m[1] !== prevPct) {
        prevPct = m[1];
        emit(`Downloading... ${prevPct}%`);
      }
    });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Download failed"))));
    proc.on("error", reject);
  });

  emit("Installing Tailscale (UAC prompt may appear)...");
  await new Promise((resolve, reject) => {
    const msiArgs = `'/i','${msiDest}','TS_NOLAUNCH=true','/quiet','/norestart'`;
    const proc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process msiexec -ArgumentList ${msiArgs} -Verb RunAs -Wait`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    proc.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) emit(line);
    });
    proc.on("close", (code) => {
      try { fs.unlinkSync(msiDest); } catch { /* ignore */ }
      if (code === 0) resolve();
      else reject(new Error(`msiexec failed (code ${code})`));
    });
    proc.on("error", reject);
  });

  // Poll until tailscale.exe appears (up to 10 s)
  emit("Verifying installation...");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(WIN_SYSTEM_BIN)) {
      emit("Installation complete.");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Installation finished but tailscale.exe not found");
}

// ── Daemon management ─────────────────────────────────────────────────────────

/**
 * Recursively ensure a directory is owned by the current user.
 * Needed when a previous root-owned daemon left behind state files we can no longer write.
 */
async function claimDirOwnership(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    const uid = process.getuid();
    const gid = process.getgid();

    // Walk all entries to detect any that belong to a different uid
    const hasAlienEntry = (() => {
      const queue = [dir];
      while (queue.length) {
        const entry = queue.pop();
        try {
          const info = fs.statSync(entry);
          if (info.uid !== uid) return true;
          if (info.isDirectory()) {
            for (const child of fs.readdirSync(entry)) {
              queue.push(path.join(entry, child));
            }
          }
        } catch { /* ignore stat errors */ }
      }
      return false;
    })();

    if (!hasAlienEntry) return;

    // Try direct chown, then passwordless sudo as fallback
    try {
      execSync(`chown -R ${uid}:${gid} "${dir}"`, { stdio: "ignore", timeout: 3000 });
    } catch {
      try {
        execSync(`sudo -n chown -R ${uid}:${gid} "${dir}"`, { stdio: "ignore", timeout: 3000 });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Detect whether the currently running daemon was started in TUN (root) mode. */
function detectDaemonMode() {
  try {
    const result = execSync(
      `pgrep -af "tailscaled.*${TAILSCALE_SOCKET}"`,
      { encoding: "utf8", timeout: 2000 }
    ).trim();
    if (!result) return null;
    // Absence of --tun=userspace-networking means TUN mode
    return !result.includes("--tun=userspace-networking");
  } catch {
    return null;
  }
}

/**
 * Launch tailscaled.
 *
 * Passing a sudoPassword starts the daemon in TUN mode (required for Funnel TLS).
 * Without a password the daemon runs in userspace-networking mode — no root needed,
 * but Funnel TLS may be unreliable.
 *
 * State files always land in the app data directory so multiple users don't collide.
 */
export async function startDaemonWithPassword(sudoPassword) {
  if (onWindows) {
    // On Windows tailscaled is a Windows Service — just start it and wait for readiness.
    const bin = locateBin();
    console.log("[Tailscale] win: net start Tailscale");
    try {
      execSync("net start Tailscale", { stdio: "ignore", windowsHide: true, timeout: 10000 });
    } catch { /* may already be running or need admin */ }

    if (!bin) return;

    // Poll BackendState until it leaves "NoState" (daemon still initialising)
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const raw = execSync(`"${bin}" status --json`, {
          encoding: "utf8",
          windowsHide: true,
          timeout: 2000,
        });
        const state = JSON.parse(raw);
        if (state.BackendState && state.BackendState !== "NoState") {
          console.log(`[Tailscale] win: BackendState=${state.BackendState} after ${attempt * 500}ms`);
          return;
        }
      } catch { /* daemon not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("[Tailscale] win: BackendState still NoState after poll");
    return;
  }

  const needRoot = !!sudoPassword;
  const existingMode = detectDaemonMode(); // true=TUN, false=userspace, null=not running

  // If daemon is already up in the mode we want, verify it responds and reuse it
  if (existingMode !== null && existingMode === needRoot) {
    try {
      const bin = locateBin() || "tailscale";
      execSync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PATH: ENRICHED_PATH },
        timeout: 3000,
      });
      return;
    } catch { /* unresponsive — fall through and restart */ }
  }

  // Kill any daemon bound to our socket (wrong mode, or unresponsive)
  try {
    execSync(`pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, { stdio: "ignore", timeout: 3000 });
  } catch { /* ignore */ }

  if (sudoPassword) {
    try { await execWithPassword(`pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, sudoPassword); }
    catch { /* ignore */ }
  } else {
    try {
      execSync(`sudo -n pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, { stdio: "ignore", timeout: 3000 });
    } catch { /* ignore */ }
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Reclaim directory in case root daemon left behind unwritable state files
  await claimDirOwnership(tsDataDir);

  const daemonExe = onMac ? "/usr/local/bin/tailscaled" : "tailscaled";
  const spawnArgs = [
    `--socket=${TAILSCALE_SOCKET}`,
    `--statedir=${tsDataDir}`,
  ];
  if (!needRoot) spawnArgs.push("--tun=userspace-networking");

  if (needRoot) {
    // TUN mode: run under sudo, feed password via stdin, detach so it outlives us
    const proc = spawn("sudo", ["-S", daemonExe, ...spawnArgs], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: ENRICHED_PATH },
    });
    proc.stdin.write(`${sudoPassword}\n`);
    proc.stdin.end();
    proc.unref();
  } else {
    const proc = spawn(daemonExe, spawnArgs, {
      detached: true,
      stdio: "ignore",
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: ENRICHED_PATH },
    });
    proc.unref();
  }

  // Allow the daemon time to bind the socket before callers try to use it
  await new Promise((r) => setTimeout(r, 3000));
}

/** Ensure the daemon is up without blocking; used by the login flow. */
function guaranteeDaemon() {
  startDaemonWithPassword("").catch(() => {});
}

// ── Login flow ────────────────────────────────────────────────────────────────

/**
 * On Windows the AuthURL is never written to stdout — it only appears in
 * `tailscale status --json`. Poll that endpoint to pick it up.
 */
function pollStatusForAuthUrl() {
  const bin = locateBin();
  if (!bin) return null;
  try {
    const raw = execSync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    const parsed = JSON.parse(raw);
    return parsed.AuthURL || null;
  } catch {
    return null;
  }
}

/**
 * Run `tailscale up` and capture the auth URL for interactive login.
 * Resolves with `{ authUrl }` or `{ alreadyLoggedIn: true }`.
 */
export function startLogin(hostname) {
  const bin = locateBin();
  if (!bin) return Promise.reject(new Error("Tailscale not installed"));

  return new Promise((resolve, reject) => {
    guaranteeDaemon();

    if (isTailscaleLoggedIn()) {
      resolve({ alreadyLoggedIn: true });
      return;
    }

    const cliArgs = buildArgs("up", "--accept-routes");
    if (hostname) cliArgs.push(`--hostname=${hostname}`);

    const proc = spawn(bin, cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });

    let settled = false;
    let accumulated = "";

    const extractAuthUrl = (text) => {
      const hit = text.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/);
      return hit ? hit[0] : null;
    };

    const settle = (url, origin) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      clearInterval(poller);
      console.log(`[Tailscale] login authUrl detected (${origin})`);
      proc.unref();
      resolve({ authUrl: url });
    };

    // Windows: poll status --json every 500 ms because AuthURL won't appear on stdout
    const poller = setInterval(() => {
      if (settled) return;
      const found = pollStatusForAuthUrl();
      if (found) settle(found, "status");
    }, 500);

    const expiry = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      proc.unref();
      const url = extractAuthUrl(accumulated) || pollStatusForAuthUrl();
      if (url) resolve({ authUrl: url });
      else reject(new Error("tailscale up timed out without auth URL"));
    }, 15000);

    const onOutput = (chunk) => {
      accumulated += chunk.toString();
      const url = extractAuthUrl(accumulated);
      if (url) settle(url, "stdout");
    };

    proc.stdout.on("data", onOutput);
    proc.stderr.on("data", onOutput);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      clearInterval(poller);
      console.error(`[Tailscale] login spawn error: ${err.message}`);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (settled) return;
      console.log(`[Tailscale] login exit code=${code}`);
      // `tailscale up` on Windows exits 0 even before auth completes — keep polling
      const url = extractAuthUrl(accumulated) || pollStatusForAuthUrl();
      if (url) {
        settle(url, "exit");
        return;
      }
      // Confirm via status before declaring success
      if (isTailscaleLoggedIn()) {
        settled = true;
        clearTimeout(expiry);
        clearInterval(poller);
        resolve({ alreadyLoggedIn: true });
        return;
      }
      // AuthURL may arrive momentarily after the process exits — let the poller catch it
    });
  });
}

// ── Funnel ────────────────────────────────────────────────────────────────────

/** Expose a local port via Tailscale Funnel. Resolves with the public tunnel URL. */
export async function startFunnel(port) {
  const bin = locateBin();
  if (!bin) throw new Error("Tailscale not installed");

  // Clear any existing funnel routes before creating a new one
  try {
    execSync(`"${bin}" ${socketArgs.join(" ")} funnel --bg reset`, {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch { /* ignore */ }

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, buildArgs("funnel", "--bg", `${port}`), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let collected = "";

    const expiry = setTimeout(() => {
      if (settled) return;
      settled = true;
      // --bg exits quickly; read the real hostname from status rather than stdout
      const url = fetchFunnelUrlNow() || getTailscaleFunnelUrl(port);
      if (url) resolve({ tunnelUrl: url });
      else reject(new Error(`Tailscale funnel timed out: ${collected.trim() || "no output"}`));
    }, 30000);

    // Always derive the URL from Self.DNSName to sidestep the -1 conflict suffix
    const deriveUrl = () => fetchFunnelUrlNow();

    let funnelDisabled = false;

    const onData = (chunk) => {
      collected += chunk.toString();

      if (collected.includes("Funnel is not enabled")) funnelDisabled = true;

      // If funnel is disabled, wait for the enable link to appear in a later chunk
      if (funnelDisabled && !settled) {
        const enableHit = collected.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
        if (enableHit) {
          settled = true;
          clearTimeout(expiry);
          proc.kill();
          resolve({ funnelNotEnabled: true, enableUrl: enableHit[0] });
          return;
        }
      }

      const url = deriveUrl();
      if (url && !settled) {
        settled = true;
        clearTimeout(expiry);
        resolve({ tunnelUrl: url });
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      console.log(`[Tailscale] funnel exit code=${code} output="${collected.trim().slice(0, 200)}"`);
      const url = deriveUrl() || getTailscaleFunnelUrl(port);
      if (url) resolve({ tunnelUrl: url });
      else reject(new Error(`tailscale funnel failed (code ${code}): ${collected.trim()}`));
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      reject(err);
    });
  });
}

/** Obtain a TLS certificate for the funnel domain so HTTPS works. Best-effort. */
export async function provisionCert(hostname) {
  const bin = locateBin();
  if (!bin || !hostname) return;
  const certsDir = path.join(tsDataDir, "certs");
  fs.mkdirSync(certsDir, { recursive: true });
  const certFile = path.join(certsDir, `${hostname}.crt`);
  const keyFile  = path.join(certsDir, `${hostname}.key`);
  try {
    await runAsync(
      `"${bin}" ${socketArgs.join(" ")} cert --cert-file "${certFile}" --key-file "${keyFile}" "${hostname}"`,
      { windowsHide: true, env: { ...process.env, PATH: ENRICHED_PATH }, timeout: 30000 }
    );
    console.log(`[Tailscale] cert provisioned for ${hostname}`);
  } catch (err) {
    console.warn(`[Tailscale] cert provision failed (non-fatal): ${err.message}`);
  }
}

/** Remove all active funnel routes. */
export function stopFunnel() {
  const bin = locateBin();
  if (!bin) return;
  try {
    execSync(`"${bin}" ${socketArgs.join(" ")} funnel --bg reset`, {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch { /* ignore */ }
}

/** Shut down the tailscaled daemon. Tries without sudo first; falls back if still running. */
export async function stopDaemon(sudoPassword) {
  // Attempt graceful kill without elevated privileges
  try { execSync("pkill -x tailscaled", { stdio: "ignore", windowsHide: true, timeout: 3000 }); }
  catch { /* ignore */ }

  // If the process is gone we're done
  try { execSync("pgrep -x tailscaled", { stdio: "ignore", windowsHide: true, timeout: 2000 }); }
  catch { return; }

  // Still alive — escalate
  if (!onWindows) {
    try { await execWithPassword("pkill -x tailscaled", sudoPassword || ""); } catch { /* ignore */ }
  }

  // Remove the socket file to avoid stale-socket errors on next start
  try {
    if (fs.existsSync(TAILSCALE_SOCKET)) fs.unlinkSync(TAILSCALE_SOCKET);
  } catch { /* ignore */ }
}
