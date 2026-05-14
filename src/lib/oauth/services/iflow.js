import { randomBytes } from "crypto";
import launch from "open";

import { IFLOW_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { startLocalServer } from "../utils/server.js";
import { spinner as createSpinner } from "../utils/ui.js";

// ---- module-private helpers ----------------------------------------------

const CALLBACK_POLL_MS = 100;
const CALLBACK_TIMEOUT_MS = 300_000; // five minutes — give the user time to log in

// Encode "<id>:<secret>" as base64 for an HTTP Basic Authorization header.
const toBasicAuthHeader = (id, secret) =>
  Buffer.from(`${id}:${secret}`).toString("base64");

// A reasonably unguessable state value for the OAuth round-trip.
const newStateNonce = () => randomBytes(32).toString("base64url");

// Throw with the response body text included so the operator sees what went wrong.
async function abortWithBody(resp, label) {
  const detail = await resp.text();
  throw new Error(`${label}: ${detail}`);
}

// Drain a JSON error response if present, otherwise fall back to a generic message.
async function abortWithJsonError(resp, fallback) {
  const payload = await resp.json();
  throw new Error(payload.error || fallback);
}

// Block until the callback handler has populated `getParams()` or the timer fires.
function awaitCallback(getParams) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error("Authentication timeout (5 minutes)")),
      CALLBACK_TIMEOUT_MS,
    );

    const pollId = setInterval(() => {
      const captured = getParams();
      if (!captured) return;
      clearInterval(pollId);
      clearTimeout(timeoutId);
      resolve();
    }, CALLBACK_POLL_MS);
  });
}

// --------------------------------------------------------------------------

/*
 * IFlowService
 * ------------
 * Drives the iFlow OAuth Authorization Code grant. iFlow expects HTTP Basic
 * credentials on the token endpoint in addition to the form fields, so we send
 * both — matching the upstream behaviour iFlow's own clients use.
 */
export class IFlowService {
  constructor() {
    this.config = IFLOW_CONFIG;
  }

  // ----- public: top-level CLI entry point --------------------------------

  async connect() {
    const ui = createSpinner("Starting iFlow OAuth...").start();

    try {
      ui.text = "Starting local server...";

      // Spin up the loopback callback listener. The OS picks a free port.
      let callbackPayload = null;
      const { port, close: stopServer } = await startLocalServer((p) => {
        callbackPayload = p;
      });

      const redirectUri = `http://localhost:${port}/callback`;
      ui.succeed(`Local server started on port ${port}`);

      // Step 1 — generate state and push the user through the browser.
      const stateNonce = newStateNonce();
      const authUrl = this.buildAuthUrl(redirectUri, stateNonce);

      console.log("\nOpening browser for iFlow authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      await launch(authUrl);

      // Step 2 — sit on the loopback server until iFlow redirects back.
      ui.start("Waiting for iFlow authorization...");
      await awaitCallback(() => callbackPayload);
      stopServer();

      if (callbackPayload.error) {
        throw new Error(
          callbackPayload.error_description || callbackPayload.error,
        );
      }
      if (!callbackPayload.code) {
        throw new Error("No authorization code received");
      }

      // Step 3 — swap the auth code for an access/refresh token pair.
      ui.start("Exchanging code for tokens...");
      const tokenSet = await this.exchangeCode(
        callbackPayload.code,
        redirectUri,
      );

      // Step 4 — fetch the iFlow profile (the apiKey lives in there).
      ui.text = "Fetching user info...";
      const profile = await this.getUserInfo(tokenSet.access_token);

      // Step 5 — persist everything back to the router server.
      ui.text = "Saving tokens to server...";
      await this.saveTokens(tokenSet, profile);

      ui.succeed(
        `iFlow connected successfully! (${profile.email || profile.phone})`,
      );
      return true;
    } catch (err) {
      ui.fail(`Failed: ${err.message}`);
      throw err;
    }
  }

  // ----- public: building blocks (kept individually testable) -------------

  // Compose the iFlow `/authorize` URL — note iFlow uses `redirect` (not the
  // usual `redirect_uri`) plus its own `loginMethod` / `type` query params.
  buildAuthUrl(redirectUri, state) {
    const cfg = this.config;
    const qs = new URLSearchParams({
      loginMethod: cfg.extraParams.loginMethod,
      type: cfg.extraParams.type,
      redirect: redirectUri,
      state,
      client_id: cfg.clientId,
    });
    return `${cfg.authorizeUrl}?${qs.toString()}`;
  }

  // POST the authorization code to iFlow's token endpoint.
  async exchangeCode(code, redirectUri) {
    const { clientId, clientSecret, tokenUrl } = this.config;
    const basic = toBasicAuthHeader(clientId, clientSecret);

    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: formBody,
    });

    if (!resp.ok) await abortWithBody(resp, "Token exchange failed");
    return resp.json();
  }

  // Fetch the iFlow profile. The endpoint takes the access token as a query
  // parameter — slightly unusual but that's what iFlow expects.
  async getUserInfo(accessToken) {
    const url = `${this.config.userInfoUrl}?accessToken=${encodeURIComponent(accessToken)}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) await abortWithBody(resp, "Failed to get user info");

    const body = await resp.json();
    if (!body.success) throw new Error("Failed to get user info");
    return body.data;
  }

  // Push the freshly obtained tokens + profile back to the router backend.
  async saveTokens(tokens, userInfo) {
    const { server, token, userId } = getServerCredentials();

    const resp = await fetch(`${server}/api/cli/providers/iflow`, {
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

    if (!resp.ok) await abortWithJsonError(resp, "Failed to save tokens");
    return resp.json();
  }
}
