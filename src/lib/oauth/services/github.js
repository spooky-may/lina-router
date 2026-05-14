// ---------------------------------------------------------------------------
// GitHub Copilot OAuth — device-code flow.
//
// GitHub does not return a refresh_token for the device flow, so once the
// access token is exchanged for a Copilot token (`copilotToken.token`), the
// caller is expected to refresh by re-running `getCopilotToken` against the
// long-lived GitHub access token.
// ---------------------------------------------------------------------------

import { OAuthService } from "./oauth.js";
import { GITHUB_CONFIG } from "../constants/oauth.js";
import { spinner as createSpinner } from "../utils/ui.js";

const FORM_HEADERS = Object.freeze({
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
});

const SLOW_DOWN_BACKOFF_MS = 5000;

function ghJsonHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
    "User-Agent": GITHUB_CONFIG.userAgent,
  };
}

async function readJsonOrThrow(response, context) {
  if (response.ok) return response.json();
  const errBody = await response.text();
  throw new Error(`Failed to ${context}: ${errBody}`);
}

async function openVerificationUrl(verificationUri) {
  try {
    const { default: open } = await import("open");
    await open(verificationUri);
  } catch {
    console.log(
      "Could not open browser automatically. Please visit the URL above manually."
    );
  }
}

function announceUserCode(verificationUri, userCode) {
  console.log(`\nPlease visit: ${verificationUri}`);
  console.log(`Enter code: ${userCode}\n`);
}

export class GitHubService extends OAuthService {
  constructor() {
    super(GITHUB_CONFIG);
  }

  // -------------------------------------------------------------------------
  // Step 1: request a device code (no auth required)
  // -------------------------------------------------------------------------
  async getDeviceCode() {
    const response = await fetch(GITHUB_CONFIG.deviceCodeUrl, {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        client_id: GITHUB_CONFIG.clientId,
        scope: GITHUB_CONFIG.scopes,
      }),
    });
    return readJsonOrThrow(response, "get device code");
  }

  // -------------------------------------------------------------------------
  // Step 2: poll until the user authorises us, the code expires, or they bail.
  // -------------------------------------------------------------------------
  async pollAccessToken(deviceCode, verificationUri, userCode, interval = 5000) {
    const spinner = createSpinner("Waiting for GitHub authentication...").start();
    announceUserCode(verificationUri, userCode);
    await openVerificationUrl(verificationUri);

    let currentInterval = interval;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((res) => setTimeout(res, currentInterval));

      const tokenResponse = await fetch(GITHUB_CONFIG.tokenUrl, {
        method: "POST",
        headers: FORM_HEADERS,
        body: new URLSearchParams({
          client_id: GITHUB_CONFIG.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const payload = await tokenResponse.json();

      if (payload.access_token) {
        spinner.succeed("GitHub authentication successful!");
        return {
          access_token: payload.access_token,
          token_type: payload.token_type,
          scope: payload.scope,
        };
      }

      switch (payload.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          currentInterval += SLOW_DOWN_BACKOFF_MS;
          continue;
        case "expired_token":
          spinner.fail("Device code expired. Please try again.");
          throw new Error("Device code expired");
        case "access_denied":
          spinner.fail("Access denied by user.");
          throw new Error("Access denied");
        default:
          spinner.fail("Failed to get access token.");
          throw new Error(payload.error_description || payload.error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3a: exchange GitHub access token for a short-lived Copilot token.
  // -------------------------------------------------------------------------
  async getCopilotToken(accessToken) {
    const response = await fetch(GITHUB_CONFIG.copilotTokenUrl, {
      headers: ghJsonHeaders(accessToken),
    });
    return readJsonOrThrow(response, "get Copilot token");
  }

  // -------------------------------------------------------------------------
  // Step 3b: fetch the authenticated user profile.
  // -------------------------------------------------------------------------
  async getUserInfo(accessToken) {
    const response = await fetch(GITHUB_CONFIG.userInfoUrl, {
      headers: ghJsonHeaders(accessToken),
    });
    return readJsonOrThrow(response, "get user info");
  }

  // -------------------------------------------------------------------------
  // Glue: full device-code → Copilot token → user-info flow.
  // -------------------------------------------------------------------------
  async authenticate() {
    try {
      const device = await this.getDeviceCode();

      const token = await this.pollAccessToken(
        device.device_code,
        device.verification_uri,
        device.user_code
      );

      const [copilotToken, userInfo] = await Promise.all([
        this.getCopilotToken(token.access_token),
        this.getUserInfo(token.access_token),
      ]);

      console.log(`\n✅ Successfully authenticated as ${userInfo.login}`);

      return {
        accessToken: token.access_token,
        copilotToken: copilotToken.token,
        refreshToken: null, // device flow does not issue refresh tokens
        expiresIn: copilotToken.expires_at,
        userInfo: {
          id: userInfo.id,
          login: userInfo.login,
          name: userInfo.name,
          email: userInfo.email,
        },
        copilotTokenInfo: copilotToken,
      };
    } catch (err) {
      throw new Error(`GitHub authentication failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // High-level: authenticate, then push credentials to the configured server.
  // -------------------------------------------------------------------------
  async connect() {
    let auth;
    try {
      auth = await this.authenticate();
    } catch (err) {
      const { error: showError } = await import("../utils/ui.js");
      showError(`GitHub connection failed: ${err.message}`);
      throw err;
    }

    const config = await import("../config/index.js");
    const { server, token, userId } = await config.getServerCredentials();

    const ui = await import("../utils/ui.js");
    const spinner = ui.spinner("Connecting to server...").start();

    try {
      const response = await fetch(`${server}/api/cli/providers/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-User-Id": userId,
        },
        body: JSON.stringify({
          accessToken: auth.accessToken,
          copilotToken: auth.copilotToken,
          userInfo: auth.userInfo,
          copilotTokenInfo: auth.copilotTokenInfo,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to connect to server");
      }

      spinner.succeed("GitHub Copilot connected successfully!");
      console.log(`\nConnected as: ${auth.userInfo.login}`);
    } catch (err) {
      const { error: showError } = await import("../utils/ui.js");
      showError(`GitHub connection failed: ${err.message}`);
      throw err;
    }
  }
}
