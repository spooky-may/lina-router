import { KIRO_CONFIG } from "../constants/oauth.js";

// ─── Endpoints ───────────────────────────────────────────────────────────────

// Cognito-fronted desktop auth service that Kiro IDE itself talks to.
const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";

// CodeWhisperer (Q Developer) data plane used for model discovery.
const CODEWHISPERER_HOST = "https://codewhisperer.us-east-1.amazonaws.com";
const LIST_MODELS_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

// AWS Cognito's whitelist only contains the kiro:// custom protocol, so the
// social-login redirect_uri is fixed — localhost is rejected.
const SOCIAL_REDIRECT_URI = "kiro://kiro.kiroAgent/authenticate-success";

// Default region for the AWS SSO OIDC endpoints.
const DEFAULT_REGION = "us-east-1";

// All refresh tokens minted by Kiro begin with this magic prefix.
const IMPORT_TOKEN_PREFIX = "aorAAAAAG";

// ─── Small utilities ─────────────────────────────────────────────────────────

const ssoOidcEndpoint = (region, suffix) =>
  `https://oidc.${region || DEFAULT_REGION}.amazonaws.com/${suffix}`;

const jsonHeaders = () => ({ "Content-Type": "application/json" });

async function failWithBody(response, prefix) {
  const text = await response.text();
  throw new Error(`${prefix}: ${text}`);
}

// Normalise the awsSso OIDC token response into our shared shape.
const shapeTokenPayload = (data) => ({
  accessToken: data.accessToken,
  refreshToken: data.refreshToken,
  expiresIn: data.expiresIn,
  tokenType: data.tokenType,
});

// ─────────────────────────────────────────────────────────────────────────────

/*
 * KiroService
 *
 * Kiro supports four ways to obtain a refresh token:
 *
 *   • AWS Builder ID  — Device Code flow against the public SSO OIDC pool
 *   • AWS IAM IDC     — Device Code flow against an enterprise SSO instance
 *   • Google / GitHub — Authorization Code flow brokered by Cognito, with the
 *                       callback delivered to the kiro:// custom protocol
 *   • Manual import   — User pastes a refresh token captured from Kiro IDE
 *
 * The methods on this class are deliberately granular: API routes call only the
 * pieces they need (e.g. social-exchange + extractEmailFromJWT) rather than a
 * single end-to-end "connect" entry point.
 */
export class KiroService {
  // ── AWS SSO OIDC: Builder ID / IDC ────────────────────────────────────────

  /*
   * Step 1 of the device-code flow. Registers a one-shot OIDC client with AWS
   * SSO and returns the credentials we'll use for the subsequent device-code
   * and token calls.
   */
  async registerClient(region = DEFAULT_REGION) {
    const response = await fetch(ssoOidcEndpoint(region, "client/register"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        clientName: KIRO_CONFIG.clientName,
        clientType: KIRO_CONFIG.clientType,
        scopes: KIRO_CONFIG.scopes,
        grantTypes: KIRO_CONFIG.grantTypes,
        issuerUrl: KIRO_CONFIG.issuerUrl,
      }),
    });

    if (!response.ok) await failWithBody(response, "Failed to register client");

    const data = await response.json();
    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientSecretExpiresAt: data.clientSecretExpiresAt,
    };
  }

  /*
   * Step 2 of the device-code flow. Asks AWS SSO for a user/device code pair
   * that the user enters on the verification page.
   */
  async startDeviceAuthorization(
    clientId,
    clientSecret,
    startUrl,
    region = DEFAULT_REGION,
  ) {
    const response = await fetch(
      ssoOidcEndpoint(region, "device_authorization"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ clientId, clientSecret, startUrl }),
      },
    );

    if (!response.ok) {
      await failWithBody(response, "Failed to start device authorization");
    }

    const data = await response.json();
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn,
      interval: data.interval || 5,
    };
  }

  /*
   * Step 3 of the device-code flow. Polls AWS SSO until the user completes the
   * web verification (or the server returns a real error). Returns an envelope
   * with `pending: true` for the expected wait-states so the caller can keep
   * polling.
   */
  async pollDeviceToken(
    clientId,
    clientSecret,
    deviceCode,
    region = DEFAULT_REGION,
  ) {
    const response = await fetch(ssoOidcEndpoint(region, "token"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    if (response.ok && !data.error) {
      return { success: true, tokens: shapeTokenPayload(data) };
    }

    const code = data.error;
    return {
      success: false,
      error: code,
      errorDescription: data.error_description,
      pending: code === "authorization_pending" || code === "slow_down",
    };
  }

  // ── Cognito social login (Google / GitHub) ────────────────────────────────

  /*
   * Compose the Cognito-hosted login URL for either Google or GitHub. The
   * caller is expected to open this in a browser; the redirect lands on the
   * kiro:// custom protocol and is intercepted by the Kiro IDE / our API.
   */
  buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === "google" ? "Google" : "Github";
    const params = new URLSearchParams({
      idp,
      redirect_uri: SOCIAL_REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      prompt: "select_account",
    });
    return `${KIRO_AUTH_SERVICE}/login?${params.toString()}`;
  }

  /*
   * Trade the authorization code from the social-login callback for a token
   * pair. The redirect_uri must exactly match the value used to start the
   * flow (see SOCIAL_REDIRECT_URI above).
   */
  async exchangeSocialCode(code, codeVerifier) {
    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: SOCIAL_REDIRECT_URI,
      }),
    });

    if (!response.ok) await failWithBody(response, "Token exchange failed");

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  // ── Token refresh ─────────────────────────────────────────────────────────

  /*
   * Refresh a Kiro token. Two code paths share this method:
   *
   *   • If `providerSpecificData` carries an AWS SSO clientId/clientSecret
   *     pair, hit the AWS SSO OIDC token endpoint (Builder ID / IDC path).
   *   • Otherwise fall through to the Cognito desktop-auth refresh endpoint
   *     (social login / imported token path).
   */
  async refreshToken(refreshToken, providerSpecificData = {}) {
    const { clientId, clientSecret, region } = providerSpecificData;

    const isAwsSsoRefresh = Boolean(clientId && clientSecret);

    if (isAwsSsoRefresh) {
      const response = await fetch(ssoOidcEndpoint(region, "token"), {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          clientId,
          clientSecret,
          refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (!response.ok) await failWithBody(response, "Token refresh failed");

      const data = await response.json();
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn: data.expiresIn,
      };
    }

    // Social / imported-token path.
    const response = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) await failWithBody(response, "Token refresh failed");

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  // ── Manual refresh-token import ───────────────────────────────────────────

  /*
   * Accept a refresh token pasted by the user (typically copied out of the
   * Kiro IDE on-disk credential store) and validate it by performing an
   * actual refresh round-trip. On success the returned envelope mirrors the
   * shape we persist for the social-login path.
   */
  async validateImportToken(refreshToken) {
    if (!refreshToken.startsWith(IMPORT_TOKEN_PREFIX)) {
      throw new Error(
        "Invalid token format. Token should start with aorAAAAAG...",
      );
    }

    try {
      const refreshed = await this.refreshToken(refreshToken);
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || refreshToken,
        profileArn: refreshed.profileArn,
        expiresIn: refreshed.expiresIn,
        authMethod: "imported",
      };
    } catch (err) {
      throw new Error(`Token validation failed: ${err.message}`);
    }
  }

  // ── CodeWhisperer model discovery ─────────────────────────────────────────

  /*
   * Ask CodeWhisperer which models the holder of `accessToken` may invoke
   * under `profileArn`. The response is normalised to our internal model
   * descriptor shape.
   */
  async listAvailableModels(accessToken, profileArn) {
    const response = await fetch(CODEWHISPERER_HOST, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": LIST_MODELS_TARGET,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ origin: "AI_EDITOR", profileArn }),
    });

    if (!response.ok) await failWithBody(response, "Failed to list models");

    const data = await response.json();
    const raw = data.models || [];
    return raw.map((m) => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: m.description,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      maxInputTokens: m.tokenLimits?.maxInputTokens || 0,
    }));
  }

  // ── JWT introspection ─────────────────────────────────────────────────────

  /*
   * Best-effort email extraction from a JWT access token. Used purely for
   * display purposes — returns null on any parse failure rather than throwing,
   * so a malformed token never blocks the surrounding flow.
   */
  extractEmailFromJWT(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;

      // base64url → base64 with padding restored.
      let payload = parts[1];
      while (payload.length % 4) payload += "=";
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");

      const claims = JSON.parse(atob(b64));
      return claims.email || claims.preferred_username || claims.sub;
    } catch {
      return null;
    }
  }
}
