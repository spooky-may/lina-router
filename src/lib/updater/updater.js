/*
 * Detached self-updater worker.
 *
 * Runs `npm i -g <pkg>@latest` out-of-process and publishes progress over a
 * tiny localhost HTTP endpoint. Because the spawner detaches and unrefs us,
 * we keep running even after the parent Next.js server shuts down.
 */

const childProcess = require("child_process");
const httpModule = require("http");
const netModule = require("net");
const pathModule = require("path");
const fsModule = require("fs");
const osModule = require("os");

const spawnProcess = childProcess.spawn;

// --- Environment-driven knobs ------------------------------------------------

const readIntEnv = (key, fallback) => parseInt(process.env[key] || fallback, 10);

const PKG_LABEL = process.env.UPDATER_PKG_NAME || "LINA Router";
const STATUS_PORT = readIntEnv("UPDATER_PORT", "20129");
const LOG_TAIL_MAX = readIntEnv("UPDATER_TAIL_LINES", "8");
const RETRY_BUDGET = readIntEnv("UPDATER_RETRIES", "3");
const RETRY_BACKOFF_MS = readIntEnv("UPDATER_RETRY_DELAY_MS", "5000");
const POST_DONE_LINGER_MS = readIntEnv("UPDATER_LINGER_MS", "30000");
const SHUTDOWN_FLOOR_MS = readIntEnv("UPDATER_WAIT_MIN_MS", "3000");
const SHUTDOWN_CEILING_MS = readIntEnv("UPDATER_WAIT_MAX_MS", "15000");
const SHUTDOWN_POLL_MS = readIntEnv("UPDATER_WAIT_CHECK_MS", "500");
const HOST_APP_PORT = readIntEnv("UPDATER_APP_PORT", "20128");

// --- Filesystem layout (mirrors mitm/paths.js) -------------------------------

function resolveDataRoot() {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || pathModule.join(osModule.homedir(), "AppData", "Roaming");
    return pathModule.join(appData, "LINA Router");
  }

  return pathModule.join(osModule.homedir(), ".LINA Router");
}

const UPDATE_ROOT = pathModule.join(resolveDataRoot(), "update");

try {
  fsModule.mkdirSync(UPDATE_ROOT, { recursive: true });
} catch {
  // best-effort directory creation
}

const STATUS_PATH = pathModule.join(UPDATE_ROOT, "status.json");
const LOG_PATH = pathModule.join(UPDATE_ROOT, "install.log");

// --- In-memory progress record ----------------------------------------------

const progress = {
  phase: "starting",
  packageName: PKG_LABEL,
  startedAt: Date.now(),
  finishedAt: null,
  attempt: 0,
  maxRetries: RETRY_BUDGET,
  done: false,
  success: false,
  exitCode: null,
  error: null,
  logTail: [],
};

// --- Tiny utilities ----------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushStatusToDisk() {
  try {
    fsModule.writeFileSync(STATUS_PATH, JSON.stringify(progress, null, 2));
  } catch {
    // best-effort persistence
  }
}

function transitionPhase(nextPhase) {
  progress.phase = nextPhase;
  flushStatusToDisk();
}

function recordLogLine(rawLine) {
  const clean = rawLine.replace(/\r?\n$/, "");
  if (!clean) return;

  progress.logTail.push(clean);
  if (progress.logTail.length > LOG_TAIL_MAX) {
    progress.logTail = progress.logTail.slice(-LOG_TAIL_MAX);
  }

  try {
    fsModule.appendFileSync(LOG_PATH, `${clean}\n`);
  } catch {
    // best-effort log append
  }
}

// --- App-port liveness probe -------------------------------------------------

function probeAppPort() {
  return new Promise((resolve) => {
    const socket = new netModule.Socket();
    const finish = (alive) => {
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(HOST_APP_PORT, "127.0.0.1");
  });
}

// --- Shutdown handshake ------------------------------------------------------
// On Windows we cannot replace files that the running app still holds open,
// so wait until the app port is no longer accepting connections (bounded).

async function awaitParentShutdown() {
  transitionPhase("waitingForExit");
  recordLogLine(`[updater] waiting for app to exit (min ${Math.round(SHUTDOWN_FLOOR_MS / 1000)}s)...`);

  // Mandatory floor — gives the OS time to release file handles.
  await delay(SHUTDOWN_FLOOR_MS);

  const giveUpAt = Date.now() + (SHUTDOWN_CEILING_MS - SHUTDOWN_FLOOR_MS);

  while (Date.now() < giveUpAt) {
    const stillUp = await probeAppPort();
    if (!stillUp) {
      recordLogLine(`[updater] app port :${HOST_APP_PORT} is free, proceeding`);
      return;
    }
    await delay(SHUTDOWN_POLL_MS);
  }

  recordLogLine(`[updater] timeout waiting for app, proceeding anyway`);
}

// --- Browser launcher --------------------------------------------------------

function launchBrowserAt(url) {
  const plat = process.platform;

  let openerCmd;
  if (plat === "darwin") {
    openerCmd = `open "${url}"`;
  } else if (plat === "win32") {
    openerCmd = `start "" "${url}"`;
  } else {
    openerCmd = `xdg-open "${url}"`;
  }

  try {
    spawnProcess(openerCmd, { shell: true, detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore — opening a browser is best effort
  }
}

async function pollForAppThenOpenDashboard() {
  const giveUpAt = Date.now() + 30000;

  while (Date.now() < giveUpAt) {
    const alive = await probeAppPort();
    if (alive) {
      launchBrowserAt(`http://localhost:${HOST_APP_PORT}/dashboard`);
      recordLogLine(`[updater] app ready, opened dashboard`);
      return;
    }
    await delay(1000);
  }

  recordLogLine(`[updater] app not responding within 30s, skip browser open`);
}

// --- Post-install relaunch --------------------------------------------------

function maybeRelaunchApp() {
  if (process.env.UPDATER_RELAUNCH !== "1") return;

  const relaunchBin = process.env.UPDATER_RELAUNCH_CMD;
  if (!relaunchBin) return;

  let relaunchArgs = [];
  try {
    relaunchArgs = JSON.parse(process.env.UPDATER_RELAUNCH_ARGS || "[]");
  } catch {
    // ignore malformed args, fall back to empty list
  }

  const onWindows = process.platform === "win32";

  try {
    const child = spawnProcess(relaunchBin, relaunchArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: onWindows,
      env: {
        ...process.env,
        UPDATER_RELAUNCH: "",
        UPDATER_RELAUNCH_CMD: "",
        UPDATER_RELAUNCH_ARGS: "",
      },
    });
    child.unref();
    recordLogLine(`[updater] relaunched: ${relaunchBin} ${relaunchArgs.join(" ")} (pid=${child.pid})`);

    // Fire-and-forget: wait until the new app is up, then pop the dashboard.
    pollForAppThenOpenDashboard();
  } catch (err) {
    recordLogLine(`[updater] relaunch failed: ${err.message}`);
  }
}

// --- Finalization ------------------------------------------------------------

function concludeRun(succeeded, code, errMsg) {
  progress.done = true;
  progress.success = succeeded;
  progress.exitCode = code;
  progress.error = errMsg;
  progress.finishedAt = Date.now();
  transitionPhase(succeeded ? "done" : "error");

  if (succeeded) maybeRelaunchApp();

  // Stay alive briefly so the browser can grab the terminal status,
  // then close the listening port and exit.
  setTimeout(() => {
    try { statusServer.close(); } catch { /* ignore */ }
    process.exit(succeeded ? 0 : 1);
  }, POST_DONE_LINGER_MS);
}

// --- npm install driver ------------------------------------------------------

function performInstall() {
  progress.attempt += 1;
  transitionPhase("installing");
  recordLogLine(`[updater] attempt ${progress.attempt}/${RETRY_BUDGET} — npm i -g ${PKG_LABEL} --prefer-online`);

  const onWindows = process.platform === "win32";
  const npmBin = onWindows ? "npm.cmd" : "npm";
  const npmArgs = ["i", "-g", PKG_LABEL, "--prefer-online"];

  const npmChild = spawnProcess(npmBin, npmArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: onWindows,
  });

  const fanOut = (buf) => {
    buf.toString().split(/\r?\n/).forEach(recordLogLine);
    flushStatusToDisk();
  };

  npmChild.stdout.on("data", fanOut);
  npmChild.stderr.on("data", fanOut);

  npmChild.on("error", (err) => {
    recordLogLine(`[updater] spawn error: ${err.message}`);
    concludeRun(false, null, err.message);
  });

  npmChild.on("close", (code) => {
    recordLogLine(`[updater] npm exited with code ${code}`);

    if (code === 0) {
      concludeRun(true, code, null);
      return;
    }

    if (progress.attempt < RETRY_BUDGET) {
      recordLogLine(`[updater] retrying in ${Math.round(RETRY_BACKOFF_MS / 1000)}s...`);
      setTimeout(performInstall, RETRY_BACKOFF_MS);
      return;
    }

    concludeRun(false, code, `Install failed after ${RETRY_BUDGET} attempts`);
  });
}

// --- HTTP status endpoint ----------------------------------------------------
// Browser polls this while the main Next server is offline.

const statusServer = httpModule.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.url === "/update/status" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(progress));
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

statusServer.on("error", (err) => {
  progress.error = `status server error: ${err.message}`;
  flushStatusToDisk();
});

statusServer.listen(STATUS_PORT, "127.0.0.1", () => {
  flushStatusToDisk();
  awaitParentShutdown().then(performInstall);
});
