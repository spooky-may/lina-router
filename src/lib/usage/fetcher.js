// ---------------------------------------------------------------------------
// Provider usage retrieval layer.
//
// Each upstream vendor exposes (or hides) its quota numbers in a slightly
// different shape, so we keep one small async fn per provider and route to
// it through a dispatch table. Anything we cannot truly observe returns a
// human-readable hint instead of throwing.
// ---------------------------------------------------------------------------

import {
  GITHUB_CONFIG,
  GEMINI_CONFIG,
  ANTIGRAVITY_CONFIG,
} from "@/lib/oauth/constants/oauth";

// -- shared text snippets ---------------------------------------------------

const COPILOT_QUOTA_URL = "https://api.github.com/copilot_internal/user";
const GCP_PROJECTS_URL =
  "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE";

const HINT_COPILOT_PARSE_FAIL =
  "GitHub Copilot connected. Unable to parse quota data.";
const HINT_GEMINI_CONSOLE_FALLBACK =
  "Gemini CLI uses Google Cloud quotas. Check Google Cloud Console for details.";
const HINT_GEMINI_OK =
  "Gemini CLI connected. Usage tracked via Google Cloud Console.";
const HINT_GEMINI_FAIL =
  "Unable to fetch Gemini usage. Check Google Cloud Console.";
const HINT_ANTIGRAVITY_OK =
  "Antigravity connected. Usage tracked via Google Cloud Console.";
const HINT_ANTIGRAVITY_FAIL = "Unable to fetch Antigravity usage.";
const HINT_CLAUDE_OK = "Claude connected. Usage tracked per request.";
const HINT_CLAUDE_FAIL = "Unable to fetch Claude usage.";
const HINT_CODEX_OK = "Codex connected. Check OpenAI dashboard for usage.";
const HINT_CODEX_FAIL = "Unable to fetch Codex usage.";
const HINT_QWEN_NO_RESOURCE = "Qwen connected. No resource URL available.";
const HINT_QWEN_OK = "Qwen connected. Usage tracked per request.";
const HINT_QWEN_FAIL = "Unable to fetch Qwen usage.";
const HINT_IFLOW_OK = "iFlow connected. Usage tracked per request.";
const HINT_IFLOW_FAIL = "Unable to fetch iFlow usage.";

// ---------------------------------------------------------------------------
// PUBLIC ENTRY
// ---------------------------------------------------------------------------

/**
 * Resolve usage / quota numbers for a stored provider connection.
 *
 * @param {Object} connection
 *   Connection record (must include `provider`, `accessToken`, and
 *   optionally `providerSpecificData`).
 * @returns {Promise<Object>} Either a quota payload or `{ message }`.
 */
export async function getUsageForProvider(connection) {
  const { provider, accessToken, providerSpecificData } = connection;

  const handler = PROVIDER_FETCHERS[provider];
  if (!handler) {
    return { message: `Usage API not implemented for ${provider}` };
  }

  return handler(accessToken, providerSpecificData);
}

// ---------------------------------------------------------------------------
// Per-provider fetchers (registered into dispatch table below)
// ---------------------------------------------------------------------------

// --- GitHub Copilot --------------------------------------------------------

async function pullCopilotUsage(_accessToken, providerSpecificData) {
  // The GitHub OAuth token cannot hit copilot_internal directly; we need the
  // short-lived Copilot bearer token that we previously exchanged for.
  const copilotToken = providerSpecificData?.copilotToken;

  try {
    if (!copilotToken) {
      throw new Error("Copilot token not found. Please refresh token first.");
    }

    const res = await fetch(COPILOT_QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error: ${body}`);
    }

    const payload = await res.json();

    // Paid Copilot accounts return quota_snapshots; free/limited accounts
    // return monthly_quotas + limited_user_quotas. Anything else we cannot
    // interpret.
    if (payload.quota_snapshots) {
      return shapePaidCopilotResponse(payload);
    }

    if (payload.monthly_quotas || payload.limited_user_quotas) {
      return shapeLimitedCopilotResponse(payload);
    }

    return { message: HINT_COPILOT_PARSE_FAIL };
  } catch (err) {
    throw new Error(`Failed to fetch GitHub usage: ${err.message}`);
  }
}

function shapePaidCopilotResponse(payload) {
  const snaps = payload.quota_snapshots;
  return {
    plan: payload.copilot_plan,
    resetDate: payload.quota_reset_date,
    quotas: {
      chat: normalizeCopilotSnapshot(snaps.chat),
      completions: normalizeCopilotSnapshot(snaps.completions),
      premium_interactions: normalizeCopilotSnapshot(snaps.premium_interactions),
    },
  };
}

function shapeLimitedCopilotResponse(payload) {
  const totals = payload.monthly_quotas || {};
  const used = payload.limited_user_quotas || {};

  return {
    plan: payload.copilot_plan || payload.access_type_sku,
    resetDate: payload.limited_user_reset_date,
    quotas: {
      chat: {
        used: used.chat || 0,
        total: totals.chat || 0,
        unlimited: false,
      },
      completions: {
        used: used.completions || 0,
        total: totals.completions || 0,
        unlimited: false,
      },
    },
  };
}

function normalizeCopilotSnapshot(snap) {
  if (!snap) {
    return { used: 0, total: 0, unlimited: true };
  }

  return {
    used: snap.entitlement - snap.remaining,
    total: snap.entitlement,
    remaining: snap.remaining,
    unlimited: snap.unlimited || false,
  };
}

// --- Gemini CLI ------------------------------------------------------------

async function pullGeminiUsage(accessToken) {
  // Gemini CLI piggybacks on Google Cloud project quotas. We ping the
  // Resource Manager just to confirm the token still has access; the actual
  // numbers live in the Cloud Console.
  try {
    const res = await fetch(GCP_PROJECTS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return { message: HINT_GEMINI_CONSOLE_FALLBACK };
    }

    return { message: HINT_GEMINI_OK };
  } catch (_err) {
    return { message: HINT_GEMINI_FAIL };
  }
}

// --- Antigravity -----------------------------------------------------------

async function pullAntigravityUsage(_accessToken) {
  // Antigravity is GCP-backed as well, with no public quota endpoint exposed.
  try {
    return { message: HINT_ANTIGRAVITY_OK };
  } catch (_err) {
    return { message: HINT_ANTIGRAVITY_FAIL };
  }
}

// --- Claude ----------------------------------------------------------------

async function pullClaudeUsage(_accessToken) {
  // Anthropic OAuth tokens have no quota surface; usage is observed at the
  // request level instead.
  try {
    return { message: HINT_CLAUDE_OK };
  } catch (_err) {
    return { message: HINT_CLAUDE_FAIL };
  }
}

// --- Codex (OpenAI) --------------------------------------------------------

async function pullCodexUsage(_accessToken) {
  // OpenAI usage data requires an org-scoped admin key, which we don't ask
  // for during the OAuth flow.
  try {
    return { message: HINT_CODEX_OK };
  } catch (_err) {
    return { message: HINT_CODEX_FAIL };
  }
}

// --- Qwen ------------------------------------------------------------------

async function pullQwenUsage(_accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: HINT_QWEN_NO_RESOURCE };
    }

    // Qwen may eventually expose a quota path under the resource URL; for now
    // we surface a generic OK so callers know the connection is live.
    return { message: HINT_QWEN_OK };
  } catch (_err) {
    return { message: HINT_QWEN_FAIL };
  }
}

// --- iFlow -----------------------------------------------------------------

async function pullIflowUsage(_accessToken) {
  try {
    // No documented usage endpoint at the moment.
    return { message: HINT_IFLOW_OK };
  } catch (_err) {
    return { message: HINT_IFLOW_FAIL };
  }
}

// ---------------------------------------------------------------------------
// Dispatch table — keep this at the bottom so the fns above are hoisted in.
// ---------------------------------------------------------------------------

const PROVIDER_FETCHERS = {
  github: pullCopilotUsage,
  "gemini-cli": pullGeminiUsage,
  antigravity: pullAntigravityUsage,
  claude: pullClaudeUsage,
  codex: pullCodexUsage,
  qwen: pullQwenUsage,
  iflow: pullIflowUsage,
};
