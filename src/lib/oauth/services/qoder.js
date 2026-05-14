import crypto from "crypto";
import open from "open";
import { getServerCredentials } from "../config/index.js";
import { QODER_CONFIG } from "../constants/oauth.js";
import { startLocalServer } from "../utils/server.js";
import { spinner as createSpinner } from "../utils/ui.js";

// How long we will sit waiting for the browser callback before giving up.
const QODER_CALLBACK_TIMEOUT_MS = 300000;
// Tick rate (ms) for checking whether the loopback server has been hit.
const QODER_POLL_MS = 100;
// Byte length used when generating the opaque OAuth state value.
const STATE_BYTE_LENGTH = 32;

// Qoder OAuth integration: classic Authorization Code grant, authenticated
// at the token endpoint via HTTP Basic (client_id:client_secret).
export class QoderService {
  constructor() {
    this.config = QODER_CONFIG;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Pack client_id/client_secret into the Basic auth header value.
  _basicAuthHeader() {
    const raw = `${this.config.clientId}:${this.config.clientSecret}`;
    return Buffer.from(raw).toString("base64");
  }

  // Shared POST against Qoder's /token endpoint. The form body changes per
  // grant type, the headers do not.
  async _postToTokenEndpoint(formBody, errorPrefix) {
    const resp = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${this._basicAuthHeader()}`,
      },
      body: formBody,
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`${errorPrefix}: ${error}`);
    }

    return await resp.json();
  }

  // Wait (with a hard timeout) until the loopback callback gets hit. The
  // getter is called repeatedly so the caller can mutate the captured value.
  _awaitBrowserCallback(getCallbackParams) {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error("Authentication timeout (5 minutes)"));
      }, QODER_CALLBACK_TIMEOUT_MS);

      const pollHandle = setInterval(() => {
        if (!getCallbackParams()) return;
        clearInterval(pollHandle);
        clearTimeout(timeoutHandle);
        resolve();
      }, QODER_POLL_MS);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API (auth URL + token operations)
  // ---------------------------------------------------------------------------

  // Assemble the /authorize URL the user is sent to in their browser.
  buildAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state: state,
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  // Trade an authorization_code for an access/refresh token pair.
  async exchangeCode(code, redirectUri) {
    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    return this._postToTokenEndpoint(formBody, "Token exchange failed");
  }

  // Use a refresh_token to mint a fresh access token (and usually a new
  // refresh token too).
  async refreshToken(refreshToken) {
    const formBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    return this._postToTokenEndpoint(formBody, "Token refresh failed");
  }

  // Pull the authenticated user's profile (api key, email/phone, ...) from
  // Qoder's userinfo endpoint. Qoder wraps responses in { success, data }.
  async getUserInfo(accessToken) {
    const url = `${this.config.userInfoUrl}?accessToken=${encodeURIComponent(accessToken)}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    const result = await resp.json();

    if (!result.success) {
      throw new Error("Failed to get user info");
    }

    return result.data;
  }

  // Persist the Qoder tokens (and the derived API key + identity) back to
  // the lina-router server so they can be rotated/used by the router.
  async saveTokens(tokens, userInfo) {
    const { server, token, userId } = getServerCredentials();

    const resp = await fetch(`${server}/api/cli/providers/qoder`, {
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
        apiKey: userInfo.apiKey,
        email: userInfo.email || userInfo.phone,
      }),
    });

    if (!resp.ok) {
      const error = await resp.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return await resp.json();
  }

  // Convenience wrapper: refresh, fetch fresh user info, and push the new
  // tokens back to the server. Used by the token-rotation worker.
  async refreshAndSave(existingRefreshToken) {
    const spinner = createSpinner("Refreshing Qoder token...").start();

    try {
      const tokens = await this.refreshToken(existingRefreshToken);
      const userInfo = await this.getUserInfo(tokens.access_token);
      await this.saveTokens(tokens, userInfo);
      spinner.succeed("Qoder token refreshed successfully");
      return tokens;
    } catch (error) {
      spinner.fail(`Token refresh failed: ${error.message}`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Interactive `qoder login` flow
  // ---------------------------------------------------------------------------

  // Drive the full interactive login: loopback server -> browser -> code ->
  // token exchange -> userinfo -> save to lina-router server.
  async connect() {
    const spinner = createSpinner("Starting Qoder OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      // The loopback server fires this callback once Qoder redirects the
      // browser back to /callback with either `code` or `error`.
      let callbackParams = null;
      const { port, close } = await startLocalServer((params) => {
        callbackParams = params;
      });

      const redirectUri = `http://localhost:${port}/callback`;
      spinner.succeed(`Local server started on port ${port}`);

      const state = crypto.randomBytes(STATE_BYTE_LENGTH).toString("base64url");
      const authUrl = this.buildAuthUrl(redirectUri, state);

      console.log("\nOpening browser for Qoder authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      await open(authUrl);

      spinner.start("Waiting for Qoder authorization...");

      await this._awaitBrowserCallback(() => callbackParams);

      close();

      // Surface Qoder's own error payload if the user denied / something
      // upstream went wrong.
      if (callbackParams.error) {
        throw new Error(
          callbackParams.error_description || callbackParams.error
        );
      }

      if (!callbackParams.code) {
        throw new Error("No authorization code received");
      }

      spinner.start("Exchanging code for tokens...");
      const tokens = await this.exchangeCode(callbackParams.code, redirectUri);

      spinner.text = "Fetching user info...";
      const userInfo = await this.getUserInfo(tokens.access_token);

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens, userInfo);

      spinner.succeed(
        `Qoder connected successfully! (${userInfo.email || userInfo.phone})`
      );
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}
