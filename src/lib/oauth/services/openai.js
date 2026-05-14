// =============================================================================
// OpenAI OAuth — Authorization Code flow with PKCE.
//
// Implementation mirrors the Codex flow (same auth server family) but talks
// to the consumer OpenAI authorisation host. See OPENAI_CONFIG for endpoints.
// =============================================================================

import { OAuthService } from "./oauth.js";
import { OPENAI_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { spinner as createSpinner } from "../utils/ui.js";

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function buildAuthorizationParams(redirectUri, state, codeChallenge) {
  return new URLSearchParams({
    client_id: OPENAI_CONFIG.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OPENAI_CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: OPENAI_CONFIG.codeChallengeMethod,
    ...OPENAI_CONFIG.extraParams,
  });
}

function buildTokenExchangeBody(code, redirectUri, codeVerifier) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_CONFIG.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

function tokenToPersistShape(tokens) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    idToken: tokens.id_token,
    scope: tokens.scope,
  };
}

// -----------------------------------------------------------------------------
// Service implementation
// -----------------------------------------------------------------------------

export class OpenAIService extends OAuthService {
  constructor() {
    super(OPENAI_CONFIG);
  }

  // Build the URL the user is redirected to in their browser.
  buildOpenAIAuthUrl(redirectUri, state, codeChallenge) {
    const params = buildAuthorizationParams(redirectUri, state, codeChallenge);
    return `${OPENAI_CONFIG.authorizeUrl}?${params.toString()}`;
  }

  // Trade the one-time code for an access/refresh token pair.
  async exchangeOpenAICode(code, redirectUri, codeVerifier) {
    const response = await fetch(OPENAI_CONFIG.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: buildTokenExchangeBody(code, redirectUri, codeVerifier),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Token exchange failed: ${errText}`);
    }

    return response.json();
  }

  // Push tokens up to the LINA Router server so the dashboard can route
  // requests through this provider.
  async saveTokens(tokens) {
    const { server, token, userId } = getServerCredentials();
    const endpoint = `${server}/api/cli/providers/openai`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-User-Id": userId,
      },
      body: JSON.stringify(tokenToPersistShape(tokens)),
    });

    if (!response.ok) {
      const errBody = await response.json();
      throw new Error(errBody.error || "Failed to save tokens");
    }

    return response.json();
  }

  // High-level orchestration: open browser → wait for callback → exchange
  // code → persist tokens. The spinner is the only side-effect visible to
  // CLI users.
  async connect() {
    const spinner = createSpinner("Starting OpenAI OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      const { code, codeVerifier, redirectUri } = await this.authenticate(
        "OpenAI",
        this.buildOpenAIAuthUrl.bind(this)
      );

      spinner.start("Exchanging code for tokens...");
      const tokens = await this.exchangeOpenAICode(code, redirectUri, codeVerifier);

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens);

      spinner.succeed("OpenAI connected successfully!");
      return true;
    } catch (err) {
      spinner.fail(`Failed: ${err.message}`);
      throw err;
    }
  }
}
