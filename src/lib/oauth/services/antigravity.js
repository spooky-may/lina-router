import crypto from "crypto";
import open from "open";

import { ANTIGRAVITY_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { startLocalServer } from "../utils/server.js";
import { spinner as createSpinner } from "../utils/ui.js";

// Polling cadence + ceilings for the Code Assist onboarding handshake.
const ONBOARD_POLL_DELAY_MS = 5000;
const DEFAULT_ONBOARD_ATTEMPTS = 10;
const CALLBACK_TIMEOUT_MS = 300000;
const CALLBACK_POLL_INTERVAL_MS = 100;
const STATE_BYTES = 32;
const FALLBACK_TIER_ID = "legacy-tier";

// Tiny pause helper used by the onboarding retry loop.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pull whatever shape the Code Assist API gave us for the project field and
// normalize it into a plain string id (or undefined when absent).
function normalizeProjectField(raw) {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object" && raw.id) return String(raw.id).trim();
  return undefined;
}

// Pick the first default tier id from the allowedTiers array, or fall back.
function pickDefaultTier(allowedTiers) {
  if (!Array.isArray(allowedTiers)) return FALLBACK_TIER_ID;
  const match = allowedTiers.find((tier) => tier && tier.isDefault && tier.id);
  return match ? match.id.trim() : FALLBACK_TIER_ID;
}

/*
 * AntigravityService
 * ------------------
 * Wraps Google's standard OAuth2 Authorization Code flow (same family as
 * Gemini) plus the Code Assist project/tier discovery + onboarding dance.
 */
export class AntigravityService {
  constructor() {
    this.config = ANTIGRAVITY_CONFIG;
  }

  // --- URL + headers --------------------------------------------------------

  // Compose the consent screen URL the browser is redirected to.
  buildAuthUrl(redirectUri, state) {
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  // Headers shared by every Code Assist API call.
  getApiHeaders(accessToken) {
    return {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": this.config.loadCodeAssistUserAgent,
      "X-Goog-Api-Client": this.config.loadCodeAssistApiClient,
      "Client-Metadata": this.config.loadCodeAssistClientMetadata,
    };
  }

  // Metadata blob expected by loadCodeAssist / onboardUser. The string-enum
  // values mirror the CLIProxyAPI Go reference implementation.
  getMetadata() {
    return {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    };
  }

  // --- Token + userinfo -----------------------------------------------------

  // Swap the authorization code for an access/refresh token pair.
  async exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: code,
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

    if (response.ok) {
      return response.json();
    }

    const errorBody = await response.text();
    throw new Error(`Token exchange failed: ${errorBody}`);
  }

  // Hit Google's userinfo endpoint to learn who just authenticated.
  async getUserInfo(accessToken) {
    const response = await fetch(`${this.config.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (response.ok) {
      return response.json();
    }

    const errorBody = await response.text();
    throw new Error(`Failed to get user info: ${errorBody}`);
  }

  // --- Code Assist project + onboarding ------------------------------------

  // Ask Code Assist which GCP project and tier this account belongs to.
  async loadCodeAssist(accessToken) {
    const response = await fetch(this.config.loadCodeAssistEndpoint, {
      method: "POST",
      headers: this.getApiHeaders(accessToken),
      body: JSON.stringify({ metadata: this.getMetadata() }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to load code assist: ${errorText}`);
    }

    const payload = await response.json();
    const projectId = normalizeProjectField(payload.cloudaicompanionProject);
    const tierId = pickDefaultTier(payload.allowedTiers);

    return { projectId, tierId, raw: payload };
  }

  // Single onboardUser call — does NOT loop. completeOnboarding does that.
  // (projectId is accepted but unused server-side here; kept for signature parity.)
  async onboardUser(accessToken, projectId, tierId) {
    const response = await fetch(this.config.onboardUserEndpoint, {
      method: "POST",
      headers: this.getApiHeaders(accessToken),
      body: JSON.stringify({ tierId, metadata: this.getMetadata() }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to onboard user: ${errorText}`);
    }

    return response.json();
  }

  // The onboarding endpoint is async — re-poll until `done: true` or we
  // exhaust the retry budget.
  async completeOnboarding(accessToken, projectId, tierId, maxRetries = DEFAULT_ONBOARD_ATTEMPTS) {
    let attempt = 0;
    while (attempt < maxRetries) {
      const outcome = await this.onboardUser(accessToken, projectId, tierId);

      if (outcome.done === true) {
        const resolvedId = normalizeProjectField(outcome.response?.cloudaicompanionProject) || projectId;
        return { success: true, projectId: resolvedId };
      }

      attempt += 1;
      await pause(ONBOARD_POLL_DELAY_MS);
    }

    throw new Error("Onboarding timeout - please try again");
  }

  // Legacy single-purpose helper still referenced elsewhere — pulls just the
  // project id and surfaces an error when missing.
  async fetchProjectId(accessToken) {
    const { projectId } = await this.loadCodeAssist(accessToken);
    if (!projectId) {
      throw new Error("No cloudaicompanionProject found in response");
    }
    return projectId;
  }

  // --- Persistence ----------------------------------------------------------

  // Forward the freshly minted tokens (and the resolved project id) to the
  // backing server for storage.
  async saveTokens(tokens, userInfo, projectId) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/antigravity`, {
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
        projectId: projectId, // Send projectId to server
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return response.json();
  }

  // --- Browser callback wait ------------------------------------------------

  // Poll the shared `callbackRef.current` slot until the local HTTP server
  // populates it, or bail with the standard timeout error.
  async _awaitCallback(callbackRef) {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error("Authentication timeout (5 minutes)"));
      }, CALLBACK_TIMEOUT_MS);

      const pollHandle = setInterval(() => {
        if (!callbackRef.current) return;
        clearInterval(pollHandle);
        clearTimeout(timeoutHandle);
        resolve();
      }, CALLBACK_POLL_INTERVAL_MS);
    });
  }

  // --- Public entry point ---------------------------------------------------

  // Drive the whole OAuth + onboarding sequence end-to-end.
  async connect() {
    const spinner = createSpinner("Starting Antigravity OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      // Slot used by the local HTTP server to drop the callback query string.
      const callbackRef = { current: null };
      const { port, close } = await startLocalServer((params) => {
        callbackRef.current = params;
      });

      const redirectUri = `http://localhost:${port}/callback`;
      spinner.succeed(`Local server started on port ${port}`);

      // Random opaque state value tying browser session to this CLI run.
      const state = crypto.randomBytes(STATE_BYTES).toString("base64url");
      const authUrl = this.buildAuthUrl(redirectUri, state);

      console.log("\nOpening browser for Antigravity authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      await open(authUrl);

      spinner.start("Waiting for Antigravity authorization...");
      await this._awaitCallback(callbackRef);
      close();

      const callbackParams = callbackRef.current;

      if (callbackParams.error) {
        throw new Error(callbackParams.error_description || callbackParams.error);
      }
      if (!callbackParams.code) {
        throw new Error("No authorization code received");
      }

      spinner.start("Exchanging code for tokens...");
      const tokens = await this.exchangeCode(callbackParams.code, redirectUri);

      spinner.text = "Fetching user info...";
      const userInfo = await this.getUserInfo(tokens.access_token);

      spinner.text = "Loading Code Assist configuration...";
      const { projectId, tierId } = await this.loadCodeAssist(tokens.access_token);

      if (!projectId) {
        throw new Error("No Google Cloud Project found. Please ensure you have a GCP project with Gemini Code Assist enabled.");
      }

      spinner.text = "Onboarding to Gemini Code Assist...";
      const onboardResult = await this.completeOnboarding(tokens.access_token, projectId, tierId);
      const finalProjectId = onboardResult.projectId || projectId;

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens, userInfo, finalProjectId);

      spinner.succeed(`Antigravity connected successfully! (${userInfo.email}, Project: ${finalProjectId})`);
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}
