// ===========================================================================
// OAuth service barrel.
//
// Re-exports every provider service from a single import path so callers can
// pull whatever they need without juggling individual module paths. Grouped
// loosely by category (core, anthropic-family, google-family, alibaba-family,
// independents) to make scanning easier.
// ===========================================================================

// -- core / shared ----------------------------------------------------------
export { OAuthService } from "./oauth.js";

// -- anthropic / openai-style coding agents ---------------------------------
export { ClaudeService } from "./claude.js";
export { CodexService } from "./codex.js";
export { OpenAIService } from "./openai.js";

// -- google ecosystem -------------------------------------------------------
export { GeminiCLIService } from "./gemini.js";
export { AntigravityService } from "./antigravity.js";

// -- alibaba / qwen lineage -------------------------------------------------
export { QwenService } from "./qwen.js";
export { IFlowService } from "./iflow.js";
export { QoderService } from "./qoder.js";

// -- other vendors ----------------------------------------------------------
export { GitHubService } from "./github.js";
export { KiroService } from "./kiro.js";
export { CursorService } from "./cursor.js";
