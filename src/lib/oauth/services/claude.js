import { OAuthService } from "./oauth.js";
import { CLAUDE_CONFIG } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { spinner as createSpinner } from "../utils/ui.js";

// Anthropic emits authorization codes that may carry trailing state attached
// via a `#`. Split it cleanly into the two halves the token endpoint needs.
function splitCodeAndState(rawCode) {
  const hashIdx = rawCode.indexOf("#");
  if (hashIdx === -1) {
    return { authCode: rawCode, embeddedState: "" };
  }
  return {
    authCode: rawCode.slice(0, hashIdx),
    embeddedState: rawCode.slice(hashIdx + 1),
  };
}

// Assemble the JSON payload that Anthropic's token endpoint expects. Note
// the format is JSON, not the more typical form-urlencoded.
function buildTokenPayload({ authCode, state, redirectUri, codeVerifier }) {
  return {
    code: authCode,
    state,
    grant_type: "authorization_code",
    client_id: CLAUDE_CONFIG.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
}

/*
 * ClaudeService
 * Authorization Code + PKCE flow against Anthropic's OAuth endpoints. The
 * quirks vs. generic OAuth are (a) state can be embedded in the returned
 * code after a `#`, and (b) the token exchange expects JSON not form data.
 */
export class ClaudeService extends OAuthService {
  constructor() {
    super(CLAUDE_CONFIG);
  }

  // Construct the consent URL. The leading `code=true` parameter is what
  // Anthropic uses to signal that the response should include a code.
  buildClaudeAuthUrl(redirectUri, state, codeChallenge) {
    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CONFIG.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: CLAUDE_CONFIG.scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: CLAUDE_CONFIG.codeChallengeMethod,
      state,
    });
    return `${CLAUDE_CONFIG.authorizeUrl}?${params.toString()}`;
  }

  // Trade the authorization code for tokens, accounting for the embedded
  // state quirk described above.
  async exchangeClaudeCode(code, redirectUri, codeVerifier, state) {
    const { authCode, embeddedState } = splitCodeAndState(code);

    const tokenPayload = buildTokenPayload({
      authCode,
      state: embeddedState || state,
      redirectUri,
      codeVerifier,
    });

    const response = await fetch(CLAUDE_CONFIG.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(tokenPayload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return response.json();
  }

  // Send the newly minted tokens up to the lina-router server. displayName
  // is derived server-side from the current account count.
  async saveTokens(tokens) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/claude`, {
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
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return response.json();
  }

  // Orchestrate the full flow: spawn local listener, open browser, swap
  // code for tokens, persist tokens.
  async connect() {
    const spinner = createSpinner("Starting Claude OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      const authResult = await this.authenticate(
        "Claude",
        this.buildClaudeAuthUrl.bind(this)
      );
      const { code, state, codeVerifier, redirectUri } = authResult;

      spinner.start("Exchanging code for tokens...");
      const tokens = await this.exchangeClaudeCode(
        code,
        redirectUri,
        codeVerifier,
        state
      );

      spinner.text = "Saving tokens to server...";
      await this.saveTokens(tokens);

      spinner.succeed("Claude connected successfully!");
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}
