# LINA Router — Roadmap

A rough public roadmap. Items move around as we learn from real usage. If something matters to you, open an issue or comment on an existing one — that's the strongest signal we have.

## Now (Q2 2026)

- **Stable v0.5 release** — package on npm, signed installer for macOS/Windows
- **MCP bridge for stdio plugins** — already shipped in `src/lib/mcp/stdioSseBridge.js`, polishing the registration UX
- **RTK v2 — adaptive compression** — current RTK uses static heuristics on tool_result content; v2 will sample the tail of long results before compressing
- **Cloudflare tunnel auto-provision** — currently manual; add one-click tunnel setup from the dashboard
- **Better provider observability** — per-account latency histograms, rate-limit forecasting

## Next (Q3 2026)

- **Local model support via Ollama / llama.cpp** — same auto-fallback semantics, but the cheapest tier becomes "your own GPU"
- **Per-project provider preferences** — currently global; allow `.lina-router.json` overrides per repo
- **Streaming-aware caching** — reuse cached responses across identical prompts within a session (opt-in)
- **Plugin marketplace** — community-contributed MCP plugins surfaced in the dashboard
- **Audit log export** — JSONL drain to S3/R2 for compliance use cases

## Later (Q4 2026 and beyond)

- **Multi-user / team mode** — shared provider pool, per-user quotas, RBAC
- **Hosted control plane (opt-in)** — for users who want their dashboard reachable without a local install
- **First-class native app** — wrap the dashboard in a desktop shell (Tauri) for better tray integration
- **Distillation harness** — capture prompt → response pairs from premium models, fine-tune cheaper local models

## Done

- ✅ OAuth support for Claude, GitHub Copilot, Gemini, Antigravity, Cursor, Qwen, iFlow, Kiro, OpenClaw
- ✅ Auto-fallback Subscription → Cheap → Free
- ✅ Multi-account rotation per provider
- ✅ RTK Token Saver v1
- ✅ Tailscale-based remote access (`tailscale funnel`)
- ✅ Usage tracking + dashboard
- ✅ STT / TTS / Embeddings / Image / Web routing
- ✅ Docker image + GitHub Actions publish workflow

## Out of scope

We don't plan to:

- **Build our own LLM** — there are enough already
- **Compete with cloud-hosted aggregators** — LINA Router is intentionally local-first
- **Add billing / accounts to the OSS dashboard** — that belongs in the hosted plane if it ever ships

---

This list is a forecast, not a contract. Priorities shift when users tell us something is broken or missing.
