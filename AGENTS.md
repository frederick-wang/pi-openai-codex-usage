# AGENTS.md — pi-openai-codex-usage

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that surfaces ChatGPT Codex subscription usage in the footer while an `openai-codex` provider model is active: multi-bucket limits (codex, spark, additional), earned reset credits (read + guarded consume), and a `/codex-usage` report with `--json`.

## Project standards

- **No personal information in any file**, including git history. Package coordinates (`pi-openai-codex-usage`, the GitHub repo URL) are the only identity allowed. Set the repo-local neutral git identity before the first commit.
- **Shipped text is English**; `README.zh-CN.md` mirrors it in idiomatic Chinese — same content, natural phrasing, never word-for-word; both language versions change together, with no notes about the sync process in reader-facing text.
- **UI language** follows `PI_OPENAI_CODEX_USAGE_LANG`, then locale, then English; `--json` keys stay English.
- **Zero runtime dependencies.** No runtime value imports from `@earendil-works/pi-*` packages (`--omit=dev` installs break otherwise); the overlay renders plain text and compares raw key bytes via `kb.matches`.
- **Single extension file** (`extensions/openai-codex-usage.ts`); the message catalog lives in it.
- **OAuth subscription only.** Never read `~/.codex/auth.json`; never refresh or write credentials; never persist/display the account id or tokens. The usage endpoint is `GET /wham/usage` with `Authorization: Bearer …` + `ChatGPT-Account-Id: …` + a Pi-mirrored User-Agent; fetch uses `redirect: "manual"`.
- **Reset credit consume is the only account-mutating operation** (ADR-0001): five guards — JWT/stored account match, single-match fail-closed, fresh redeem request id per attempt, explicit confirmation UI, outcome explained + snapshot refetch.
- **MIT license** — keep the `LICENSE` file and the `license` field in sync.

## Hard-won implementation notes (carried from pi-xai-usage / pi-glm-usage / pi-deepseek-balance)

- Seed activation in `session_start` from `ctx.model` (`SessionStartEvent` has no `model` field in pi 0.84.4). `model_select` alone never fires on a plain startup; tolerate `ctx.model === undefined` at startup and let `model_select` arm.
- Gate automatic polling on `ctx.mode`/`ctx.hasUI` per event, never `stdout.isTTY`; `json`/`rpc` modes get no stdout writes; only `print` mode may `console.log`. The explicit `/codex-usage` command may fetch in print mode; lifecycle events must not resolve auth or hit network when not interactive.
- `getProviderAuth` can throw and can refresh+persist a token internally. Call it only inside the throttled fetch, in try/catch. Never on countdown ticks.
- `ctx.ui.setStatus(key, undefined)` clears the slot.
- Overlay: `render(width): string[]` (never a joined string); `maxHeight: "80%"` matching pi's clip; live `rowGen`; keybinding ids `tui.select.confirm` / `cancel` / `up` / `down` / `pageUp` / `pageDown` / `tui.altScreen.top` / `bottom`.
- Stale marker must not read as a percent literal (`43%~` is wrong); put it before the bar or as a dim prefix.
- **WS caveat (ADR-0004):** pi 0.84.4 default transport for `openai-codex` is `auto` (WebSocket first); the WS path never fires `after_provider_response`, so passive header merge is opportunistic only. Never treat headers as a source; merge only over an existing snapshot, per-bucket, field-wise, and never extend snapshot freshness.
- **Window labels are dynamic (ADR-0006):** derive from the server duration; `primary`/`secondary` are wire slots, never semantic names; missing windows render `n/a`, never fake `0%`.
- **Reached-ness (ADR-0001/consensus):** key UX off `rate_limit_reached_type` (opaque string, kind-aware copy; unknown kinds get the generic message); `allowed`/`limitReached` are wire passthrough hints only.
- Refresh model (ADR-0005): activation + model_select + `agent_settled` debounced ≥60s (+`agent_end`) + 5-minute heartbeat while active + one-shot after `resetsAt` (exhausted state) + Retry-After one-shot. Countdown redraw is local only; never resolves auth or fetches.
- Before any release: install the packed tarball into a throwaway project and run it under real `pi` once. Live-check (`scripts/live-check.ts`) is user-consented (one read-only `GET /wham/usage`); never in CI. **After a tarball smoke test, uninstall the throwaway install (`pi uninstall <path>`) and delete the throwaway dir — a leftover path install registers duplicate slash commands for the real npm package in every session (repasted `codex-usage:1`/`codex-usage:2`).**
- pnpm 11 build policy: `pnpm-workspace.yaml` `allowBuilds` with `true`/`false` values (v10 names are ignored; `block` is invalid).
- Editing `package.json` dependencies requires regenerating the lockfile in the same commit.
- `gh pr checks` emits `pass`/`fail`; `gh run view` emits `success`/`failure`.
- npm publish is OIDC trusted publishing: `actions/setup-node` + `registry-url`, then `npm publish --access public` with no `NODE_AUTH_TOKEN`. The trusted publisher is `frederick-wang/pi-openai-codex-usage` workflow `release.yml`, no GitHub Environment. pnpm/setup alone yields ENEEDAUTH. `repository.url` must use the `git+https://` form. An anonymous PUT is **404**, not 401.
- Reader-facing text carries no maintainer meta-notes; the zh README is written as Chinese a Chinese engineer would write.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles with default names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
