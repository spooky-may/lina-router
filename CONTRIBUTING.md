# Contributing to LINA Router

Thanks for considering a contribution. This project moves fast, but we try to keep the bar consistent. A few notes before you open an issue or PR.

## Getting set up

```bash
git clone https://github.com/spooky-may/lina-routerr.git
cd lina-routerr
pnpm install
pnpm dev
```

The dashboard runs at `http://localhost:20128`. The proxy is reachable at `http://localhost:20128/v1` (OpenAI-compatible) — point your CLI tool's base URL there.

For development against the bundled cloud worker:

```bash
pnpm -C cloud dev
```

## What we're looking for

We prioritize, roughly in this order:

1. **Bug reports with reproducers.** A 10-line snippet that triggers the bug is worth more than a 200-word description.
2. **Provider integrations.** New OAuth providers, new model families, fixes to existing provider quirks. See `src/lib/oauth/providers.js` and `open-sse/handlers/`.
3. **Token-saver improvements.** Anything that improves the RTK compression ratio without regressing accuracy. Benchmarks required — `pnpm bench:rtk`.
4. **Dashboard UX.** Most users only see the dashboard. Polish here matters.

We are **not** looking for:

- "Refactors" with no behavior change and no measurable benefit
- Adding new dependencies for trivial functionality
- Renames or stylistic sweeps across the codebase

## PR checklist

Before opening a PR, please make sure:

- [ ] `pnpm test` passes locally (or at minimum the test files you touched)
- [ ] `pnpm lint` is clean
- [ ] You've added a test if you fixed a bug
- [ ] Your commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`)
- [ ] If you touched OAuth / token storage / providers, you've manually verified the affected providers still authenticate

## Commit message style

Subject lines: ≤72 chars, imperative mood, lowercase after the colon.

```
feat(providers): add Cohere Command R+ support
fix(rtk): handle tool_result content arrays with mixed text/image blocks
refactor(db): split usage repo from connection repo
```

Body: optional, but if you include one, explain the **why**, not the **what**. The diff already shows the what.

## Issue triage labels

- `bug` — confirmed reproducible
- `needs-repro` — can't reproduce without more info
- `provider:<name>` — issue is specific to a single provider
- `discussion` — design question, no code change yet
- `good first issue` — small, well-scoped, mentor available

## Security disclosures

If you find a security vulnerability, **do not open a public issue.** Email `security@linarouter.dev` with the details and we'll respond within 48 hours. We don't currently run a paid bounty program but we'll credit you in the release notes if you'd like.

## Code style

- JavaScript ES modules, no TypeScript in `lina-router/` (the cloud worker uses TS via JSDoc + `jsconfig.json`)
- 2-space indentation
- Double quotes for strings
- Prefer `const`, then `let`. Never `var`.
- Avoid `default export` for anything that's not a React component
- For React: function components only, hooks for state, no class components

## License

By contributing, you agree your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
