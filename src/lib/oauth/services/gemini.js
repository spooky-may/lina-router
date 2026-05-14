import crypto from "crypto";
import open from "open";

import { GEMINI_CONFIG, getOAuthClientMetadata } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { startLocalServer } from "../utils/server.js";
import { spinner as createSpinner } from "../utils/ui.js";

// Wait at most this long for the user to complete the Google consent screen.
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
// How often to peek at the local server's callbackParams slot.
const CALLBACK_POLL_INTERVAL_MS = 100;

// Cloud Code Assist endpoint used to resolve the user's GCP project id.
const LOAD_CODE_ASSIST_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

// Spoofed client identifiers — Google's gateway rejects requests that don't
// look like their first-party tooling.
const GOOGLE_USER_AGENT = "google-api-nodejs-client/9.15.1";
const GOOGLE_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";

/**
 * OAuth driver for the Gemini CLI (the Google Cloud Code Assist surface).
 *
 * Plain Authorization Code grant — Google's CLI client is "public" but they
 * ship a client_secret anyway, so PKCE is unnecessary here.
 */
export class GeminiCLIService {
  constructor() {
    this.config = GEMINI_CONFIG;
  }

  // ---------------------------------------------------------------------
  // High-level: drive the entire connect flow end-to-end.
  // ---------------------------------------------------------------------
  async connect() {
    const spinner = createSpinner("Starting Gemini OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      // The local one-shot HTTP server captures the OAuth redirect.
      let callbackParams = null;
      const { port, close } = await startLocalServer((params) => {
        callbackParams = params;
      });

      const redirectUri = `http://localhost:${port}/callback`;
      spinner.succeed(`Local server started on port ${port}`);

      const state = crypto.randomBytes(32).toString("base64url");
      const authUrl = this.buildAuthUrl(redirectUri, state);

      console.log("\nOpening browser for Google authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);
      await open(authUrl);

      spinner.start("Waiting for Google authorization...");
      await this._awaitCallback(() => callbackParams);
      close();

      if (callbackParams.error) {
        throw new Error(
          callbackParams.error_description || callbackParams.error,
        );
      }
      if (!callbackParams.code) {
        throw new Error("No authorization code received");
      }

      spinner.start("Exchanging code for tokens...");
      const tokens = await this.exchangeCode(callbackParams.code, redirectUri);

      spinner.text = "Fetching user info...";
      const userInfo = await this.getUserInfo(tokens.access_token);

      spinner.text = "Fetching project ID...";
      const projectId = await this.fetchProjectId(tokens.access_token);

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens, userInfo, projectId);

      spinner.succeed(
        `Gemini CLI connected successfully! (${userInfo.email}, Project: ${projectId})`,
      );
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }

  // Block until callbackParams is populated or we hit the consent timeout.
  // Kept separate so connect() reads as a flat script.
  _awaitCallback(getParams) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Authentication timeout (5 minutes)"));
      }, CALLBACK_TIMEOUT_MS);

      const poll = setInterval(() => {
        if (!getParams()) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, CALLBACK_POLL_INTERVAL_MS);
    });
  }

  // ---------------------------------------------------------------------
  // Step builders. Each does one HTTP round-trip.
  // ---------------------------------------------------------------------

  // Compose the consent screen URL. access_type=offline + prompt=consent makes
  // Google reliably emit a refresh_token even on repeat authorizations.
  buildAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  // Trade the authorization code for an access+refresh token pair.
  async exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }
    return response.json();
  }

  // Pull basic profile info from the standard Google userinfo endpoint.
  async getUserInfo(accessToken) {
    const response = await fetch(`${this.config.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }
    return response.json();
  }

  // Call loadCodeAssist to figure out which GCP project the user is bound to.
  // The response may carry the project as a string or as a {id} object — we
  // tolerate both shapes.
  async fetchProjectId(accessToken) {
    const metadata = getOAuthClientMetadata();

    const response = await fetch(LOAD_CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": GOOGLE_USER_AGENT,
        "X-Goog-Api-Client": GOOGLE_API_CLIENT,
        "Client-Metadata": JSON.stringify(metadata),
      },
      body: JSON.stringify({ metadata, mode: 1 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch project ID: ${error}`);
    }

    const data = await response.json();
    const raw = data.cloudaicompanionProject;

    let projectId = "";
    if (typeof raw === "string") {
      projectId = raw.trim();
    } else if (raw?.id) {
      projectId = raw.id.trim();
    }

    if (!projectId) {
      throw new Error("No project ID found in response");
    }
    return projectId;
  }

  // Hand the credentials over to the LINA Router backend so it can rotate
  // accounts for inference traffic.
  async saveTokens(tokens, userInfo, projectId) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/gemini-cli`, {
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
        scope: tokens.scope,
        email: userInfo.email,
        projectId,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }
    return response.json();
  }
}
