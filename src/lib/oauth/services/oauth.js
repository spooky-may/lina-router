import open from "open";
import { OAUTH_TIMEOUT } from "../constants/oauth.js";
import { generatePKCE } from "../utils/pkce.js";
import { startLocalServer } from "../utils/server.js";
import { spinner as createSpinner } from "../utils/ui.js";

// Reusable poll interval (ms) used while waiting for the loopback callback
const CALLBACK_POLL_MS = 100;

// Base implementation of the standard Authorization Code + PKCE flow.
// Provider-specific subclasses (Claude, OpenAI, Codex, GitHub, ...) plug
// in their own auth-URL builders and token handling on top of this.
export class OAuthService {
  constructor(config) {
    this.config = config;
  }

  // Compose the provider's /authorize URL from PKCE + state + any
  // provider-specific query overrides.
  buildAuthUrl(redirectUri, state, codeChallenge, extraParams = {}) {
    const query = new URLSearchParams();
    query.set("client_id", this.config.clientId);
    query.set("response_type", "code");
    query.set("redirect_uri", redirectUri);
    query.set("state", state);
    query.set("code_challenge", codeChallenge);
    query.set("code_challenge_method", this.config.codeChallengeMethod);
    for (const [k, v] of Object.entries(extraParams)) {
      query.set(k, v);
    }

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  // Swap an authorization_code for a token bundle. Some providers want
  // application/json bodies (e.g. Claude), others stick to form-urlencoded.
  async exchangeCode(
    code,
    redirectUri,
    codeVerifier,
    contentType = "application/x-www-form-urlencoded"
  ) {
    const payload = {
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code: code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    };

    const useJson = contentType === "application/json";
    const requestBody = useJson
      ? JSON.stringify(payload)
      : new URLSearchParams(payload);

    const resp = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: requestBody,
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await resp.json();
  }

  // Spin up the loopback HTTP server, hand back the redirect URI, and
  // expose a waitForCallback() helper that resolves once the browser
  // hits /callback (or rejects on timeout/explicit error).
  async startAuthFlow(authUrl, providerName) {
    const spinner = createSpinner("Starting local server...").start();

    // The loopback server stashes incoming query params here for the
    // wait helper to pick up.
    let receivedParams = null;
    const { port, close } = await startLocalServer((params) => {
      receivedParams = params;
    });

    const redirectUri = `http://localhost:${port}/callback`;
    spinner.succeed(`Local server started on port ${port}`);

    const waitForCallback = async () => {
      spinner.start(`Waiting for ${providerName} authorization...`);

      await new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error("Authentication timeout (5 minutes)"));
        }, OAUTH_TIMEOUT);

        const pollHandle = setInterval(() => {
          if (!receivedParams) return;
          clearInterval(pollHandle);
          clearTimeout(timeoutHandle);
          resolve();
        }, CALLBACK_POLL_MS);
      });

      spinner.stop();
      close();

      if (receivedParams.error) {
        throw new Error(
          receivedParams.error_description || receivedParams.error
        );
      }

      if (!receivedParams.code) {
        throw new Error("No authorization code received");
      }

      return receivedParams;
    };

    return {
      redirectUri,
      port,
      close,
      waitForCallback,
    };
  }

  // End-to-end driver: mint PKCE, boot the loopback server, open the
  // browser, await the callback, validate state, and return the
  // material that the subclass needs to finish its token exchange.
  async authenticate(providerName, buildAuthUrlFn) {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const { redirectUri, waitForCallback } = await this.startAuthFlow(
      null,
      providerName
    );

    const authUrl = buildAuthUrlFn(redirectUri, state, codeChallenge);

    console.log(`\nOpening browser for ${providerName} authentication...`);
    console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

    await open(authUrl);

    const callback = await waitForCallback();

    // Reject any CSRF-style state mismatch up front so the caller never
    // sees a token derived from a tampered redirect.
    if (callback.state !== state) {
      throw new Error("Invalid state parameter");
    }

    return {
      code: callback.code,
      state: callback.state,
      codeVerifier,
      redirectUri,
    };
  }
}
