// ---------------------------------------------------------------------------
// Qwen OAuth — device-code flow with PKCE.
//
// The flow:
//   1. Generate PKCE pair (verifier kept locally, challenge sent to Qwen).
//   2. Request a device + user code; Qwen prefers `verification_uri_complete`
//      because it embeds the user code, so the user only has to click.
//   3. Poll the token endpoint at the cadence Qwen suggests (default 5s).
//   4. Hand the resulting access/refresh tokens to the LINA Router server.
// ---------------------------------------------------------------------------

import open from "open";
import { QWEN_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { generatePKCE } from "../utils/pkce.js";
import { spinner as createSpinner } from "../utils/ui.js";

// 5 minutes worth of poll cycles at the default 5s interval.
const MAX_POLL_ATTEMPTS = 60;
const SLOW_DOWN_DELAY_MS = 5000;

const FORM_ACCEPT_JSON = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function pickVerificationUrl(deviceData) {
  return deviceData.verification_uri_complete || deviceData.verification_uri;
}

function announceUserPrompt(deviceData) {
  console.log("\n📋 Please visit the following URL and enter the code:\n");
  console.log(`   ${deviceData.verification_uri}\n`);
  console.log(`   Code: ${deviceData.user_code}\n`);
}

export class QwenService {
  constructor() {
    this.config = QWEN_CONFIG;
  }

  // -------------------------------------------------------------------------
  // POST /device_code → returns { device_code, user_code, verification_uri, … }
  // -------------------------------------------------------------------------
  async requestDeviceCode(codeChallenge) {
    const response = await fetch(this.config.deviceCodeUrl, {
      method: "POST",
      headers: FORM_ACCEPT_JSON,
      body: new URLSearchParams({
        client_id: this.config.clientId,
        scope: this.config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: this.config.codeChallengeMethod,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Device code request failed: ${errBody}`);
    }

    return response.json();
  }

  // -------------------------------------------------------------------------
  // Poll until Qwen returns tokens, the user declines, or the device code
  // expires. Returns the raw token response on success.
  // -------------------------------------------------------------------------
  async pollForToken(deviceCode, codeVerifier, interval = 5) {
    const pollDelayMs = interval * 1000;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await wait(pollDelayMs);

      const response = await fetch(this.config.tokenUrl, {
        method: "POST",
        headers: FORM_ACCEPT_JSON,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: this.config.clientId,
          device_code: deviceCode,
          code_verifier: codeVerifier,
        }),
      });

      if (response.ok) return response.json();

      const errBody = await response.json();
      const code = errBody.error;

      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        await wait(SLOW_DOWN_DELAY_MS);
        continue;
      }
      if (code === "expired_token") throw new Error("Device code expired");
      if (code === "access_denied") throw new Error("Access denied");

      throw new Error(errBody.error_description || code);
    }

    throw new Error("Authorization timeout");
  }

  // -------------------------------------------------------------------------
  // Hand tokens to the LINA Router server-side endpoint that persists them.
  // -------------------------------------------------------------------------
  async saveTokens(tokens) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/qwen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-User-Id": userId,
      },
      body: JSON.stringify({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        resourceUrl: tokens.resource_url,
      }),
    });

    if (!response.ok) {
      const errBody = await response.json();
      throw new Error(errBody.error || "Failed to save tokens");
    }

    return response.json();
  }

  // -------------------------------------------------------------------------
  // Public entry point used by the CLI. Single async pipeline with a single
  // spinner so the user sees stage-by-stage progress.
  // -------------------------------------------------------------------------
  async connect() {
    const spinner = createSpinner("Starting Qwen OAuth...").start();

    try {
      spinner.text = "Generating PKCE...";
      const { codeVerifier, codeChallenge } = generatePKCE();

      spinner.text = "Requesting device code...";
      const deviceData = await this.requestDeviceCode(codeChallenge);

      spinner.stop();
      announceUserPrompt(deviceData);
      await open(pickVerificationUrl(deviceData));

      spinner.start("Waiting for authorization...");
      const tokens = await this.pollForToken(
        deviceData.device_code,
        codeVerifier,
        deviceData.interval || 5
      );

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens);

      spinner.succeed("Qwen connected successfully!");
      return true;
    } catch (err) {
      spinner.fail(`Failed: ${err.message}`);
      throw err;
    }
  }
}
