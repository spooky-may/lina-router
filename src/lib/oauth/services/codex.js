import open from "open";

import { OAuthService } from "./oauth.js";
import { CODEX_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { startLocalServer } from "../utils/server.js";
import { generatePKCE } from "../utils/pkce.js";
import { spinner as createSpinner } from "../utils/ui.js";

// Codex CLI hardcodes 1455 as its loopback port — match it so users with an
// existing browser session don't get caught by OpenAI's redirect_uri check.
const CODEX_LOOPBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const AUTH_TIMEOUT_MS = 300000;
const TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded";

// OpenAI's authorize endpoint is finicky about spaces — they MUST be %20,
// not the `+` that URLSearchParams produces. Hand-roll the query string.
function encodeQueryStrict(paramsObj) {
  const parts = [];
  for (const key of Object.keys(paramsObj)) {
    parts.push(`${key}=${encodeURIComponent(paramsObj[key])}`);
  }
  return parts.join("&");
}

/*
 * CodexService — OpenAI (Codex CLI) OAuth.
 *
 * Standard PKCE Authorization Code flow with one wrinkle: the authorize URL
 * has to be hand-encoded (see encodeQueryStrict) and the redirect URI must
 * land on the fixed loopback port 1455.
 */
export class CodexService extends OAuthService {
  constructor() {
    super(CODEX_CONFIG);
  }

  // Assemble the consent URL with strict %20 encoding.
  buildCodexAuthUrl(redirectUri, state, codeChallenge) {
    const params = {
      response_type: "code",
      client_id: CODEX_CONFIG.clientId,
      redirect_uri: redirectUri,
      scope: CODEX_CONFIG.scope,
      code_challenge: codeChallenge,
      code_challenge_method: CODEX_CONFIG.codeChallengeMethod,
      ...CODEX_CONFIG.extraParams,
      state,
    };

    return `${CODEX_CONFIG.authorizeUrl}?${encodeQueryStrict(params)}`;
  }

  // Push tokens to the lina-router server for persistence.
  async saveTokens(tokens) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/codex`, {
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
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return response.json();
  }

  // Block until the local HTTP server sees a /auth/callback hit, or fail
  // with the standard timeout message once the budget elapses.
  _waitForCallback(getCallbackParams) {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poller);
        reject(new Error("Authentication timeout (5 minutes)"));
      }, AUTH_TIMEOUT_MS);

      const poller = setInterval(() => {
        const params = getCallbackParams();
        if (!params) return;
        clearInterval(poller);
        clearTimeout(deadline);
        resolve(params);
      }, 100);
    });
  }

  // Validate the params delivered to the loopback callback; throw with the
  // exact messages the rest of the CLI expects.
  _assertCallbackOk(callbackParams) {
    if (callbackParams.error) {
      throw new Error(callbackParams.error_description || callbackParams.error);
    }
    if (!callbackParams.code) {
      throw new Error("No authorization code received");
    }
  }

  // Run the whole flow front-to-back.
  async connect() {
    const spinner = createSpinner("Starting Codex OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      // Use a mutable slot the loopback handler can write into.
      let callbackParams = null;
      const setCallback = (params) => {
        callbackParams = params;
      };
      const getCallback = () => callbackParams;

      const { port, close } = await startLocalServer(setCallback, CODEX_LOOPBACK_PORT);
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
      spinner.succeed(`Local server started on port ${port}`);

      // PKCE pair + opaque state value for this run.
      const { codeVerifier, codeChallenge, state } = generatePKCE();
      const authUrl = this.buildCodexAuthUrl(redirectUri, state, codeChallenge);

      console.log("\nOpening browser for OpenAI authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      await open(authUrl);

      spinner.start("Waiting for OpenAI authorization...");
      const received = await this._waitForCallback(getCallback);
      close();

      this._assertCallbackOk(received);

      spinner.start("Exchanging code for tokens...");
      // Codex's token endpoint speaks form-urlencoded (unlike Claude).
      const tokens = await this.exchangeCode(
        received.code,
        redirectUri,
        codeVerifier,
        TOKEN_CONTENT_TYPE
      );

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens);

      spinner.succeed("Codex connected successfully!");
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}
