import { CURSOR_CONFIG } from "../constants/oauth.js";

// ---------------------------------------------------------------------------
// Cursor IDE integration via state.vscdb token import.
//
// Cursor stashes its session credentials inside a local SQLite store. The
// path varies by host operating system:
//   * GNU/Linux    -> ~/.config/Cursor/User/globalStorage/state.vscdb
//   * Apple macOS  -> ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   * Windows NT   -> %APPDATA%\Cursor\User\globalStorage\state.vscdb
//
// Two rows from itemTable are relevant:
//   * cursorAuth/accessToken        -> the bearer token
//   * storage.serviceMachineId      -> stable per-install identifier
// ---------------------------------------------------------------------------

// Cursor's bearer payload in the SQLite blob is at least this many characters
// when valid. Shorter strings are pasted-in placeholders/typos.
const MIN_TOKEN_CHARS = 50;

// Machine identifiers shipped by Cursor look like UUIDs once dashes are removed
// (32 hex chars). The DB occasionally stores a longer hex form, so be loose.
const HEX_ID_PATTERN = /^[a-f0-9-]{32,}$/i;

// Cursor sessions persist around a day. Reflect that in expiresIn so callers
// schedule renewals at a sensible cadence.
const SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

// Initial byte for the rolling XOR cipher Cursor uses to wrap timestamps in
// the x-cursor-checksum header.
const CIPHER_SEED = 165;

const PLATFORM_LABELS = {
  win32: "windows",
  darwin: "macos",
};

const ARCH_LABELS = {
  x64: "x86_64",
  arm64: "aarch64",
};

// ---------------------------------------------------------------------------
// Pure helpers (kept out of the class so they're cheap to reason about).
// ---------------------------------------------------------------------------

// Cursor's "jyh" obfuscation: walk timestamp chars, XOR each with a key that
// drifts on every byte, then base64 the buffer. Output is appended with the
// machine id after a comma.
function obfuscateTimestamp(machineId) {
  const stamp = String(Math.floor(Date.now() / 1000));
  const wrapped = new Array(stamp.length);
  let drift = CIPHER_SEED;

  for (let idx = 0; idx < stamp.length; idx += 1) {
    const code = stamp.charCodeAt(idx);
    wrapped[idx] = code ^ drift;
    drift = (drift + code) & 0xff;
  }

  const base = Buffer.from(wrapped).toString("base64");
  return `${base},${machineId}`;
}

function currentPlatformLabel() {
  if (typeof process === "undefined") return "linux";
  return PLATFORM_LABELS[process.platform] ?? "linux";
}

function currentArchLabel() {
  if (typeof process === "undefined") return "x86_64";
  const raw = process.arch;
  return ARCH_LABELS[raw] ?? raw;
}

// Best-effort JWT payload decode. Cursor sometimes ships JWT-style tokens with
// a sub/email claim; older releases ship opaque strings. Either is fine.
function tryDecodeJwtPayload(token) {
  const segments = token.split(".");
  if (segments.length !== 3) return null;

  let payload = segments[1];
  while (payload.length % 4 !== 0) payload += "=";

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(normalized, "base64").toString();
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Service class. Methods are kept thin so the heavy logic lives in helpers.
// ---------------------------------------------------------------------------

export class CursorService {
  constructor() {
    this.config = CURSOR_CONFIG;
  }

  // Public-facing checksum entrypoint. Delegates to the standalone obfuscator
  // so the cipher can be unit-tested in isolation.
  generateChecksum(machineId) {
    return obfuscateTimestamp(machineId);
  }

  detectOS() {
    return currentPlatformLabel();
  }

  detectArch() {
    return currentArchLabel();
  }

  // Builds the request header bag the Cursor proxy expects. Anything missing
  // here will be rejected upstream with a vague 400.
  buildHeaders(accessToken, machineId, ghostMode = false) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-version": this.config.clientVersion,
      "x-cursor-client-type": this.config.clientType,
      "x-cursor-client-os": this.detectOS(),
      "x-cursor-client-arch": this.detectArch(),
      "x-cursor-client-device-type": "desktop",
      "x-cursor-checksum": this.generateChecksum(machineId),
      "x-ghost-mode": ghostMode ? "true" : "false",
    };
  }

  // Sanity-check the imported credentials before storing them. We deliberately
  // skip a network round-trip here: Cursor's connect+proto endpoints need a
  // protobuf body, so first real use is when validation actually happens.
  async validateImportToken(accessToken, machineId) {
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("Access token is required");
    }
    if (!machineId || typeof machineId !== "string") {
      throw new Error("Machine ID is required");
    }
    if (accessToken.length < MIN_TOKEN_CHARS) {
      throw new Error("Invalid token format. Token appears too short.");
    }

    const stripped = machineId.replace(/-/g, "");
    if (!HEX_ID_PATTERN.test(stripped)) {
      throw new Error("Invalid machine ID format. Expected UUID format.");
    }

    return {
      accessToken,
      machineId,
      expiresIn: SESSION_LIFETIME_SECONDS,
      authMethod: "imported",
    };
  }

  // If the token is a JWT, pull email/userId out of the payload. Anything
  // unexpected (bad base64, not three segments, missing claims) is swallowed
  // — callers treat the null return as "no user metadata available".
  extractUserInfo(accessToken) {
    let decoded;
    try {
      decoded = tryDecodeJwtPayload(accessToken);
    } catch {
      return null;
    }
    if (!decoded) return null;

    return {
      email: decoded.email || decoded.sub,
      userId: decoded.sub || decoded.user_id,
    };
  }

  // Step-by-step crib sheet shown to the UI when a user picks "import" rather
  // than going through the desktop helper.
  getTokenStorageInstructions() {
    const paths = this.config.tokenStoragePaths;

    const steps = [
      "1. Open Cursor IDE and make sure you're logged in",
      "2. Find the state.vscdb file:",
      `   - Linux: ${paths.linux}`,
      `   - macOS: ${paths.macos}`,
      `   - Windows: ${paths.windows}`,
      "3. Open the database with SQLite browser or CLI:",
      "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='cursorAuth/accessToken'\"",
      "4. Also get the machine ID:",
      "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='storage.serviceMachineId'\"",
      "5. Paste both values in the form below",
    ];

    const alternativeMethod = [
      "Or use this one-liner to get both values:",
      "sqlite3 state.vscdb \"SELECT key, value FROM itemTable WHERE key IN ('cursorAuth/accessToken', 'storage.serviceMachineId')\"",
    ];

    return {
      title: "How to get your Cursor token",
      steps,
      alternativeMethod,
    };
  }
}
