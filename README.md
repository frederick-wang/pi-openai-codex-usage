# pi-openai-codex-usage

English | [简体中文](./README.zh-CN.md)

> **Unofficial.** Not affiliated with OpenAI. Reads the same ChatGPT usage endpoint the official Codex client uses (`/backend-api/wham/usage`). It is not a documented public API and may change without notice. The package may stop working at any time.

ChatGPT Codex subscription usage in the
[pi coding agent](https://github.com/earendil-works/pi-mono) footer, with a full `/codex-usage` report.

```
codex 5h ████████░ 43% · 7d █████████░ 12% ↻5h 12m
```

## What it shows

While an `openai-codex` model is active, the footer shows the **active bucket** (the limit the server meters for the model in use, e.g. `codex` or `spark`), one 8-cell bar per window (up to two), the **remaining** percent, and the nearest reset countdown. Stale data is marked. Multi-bucket plans, weekly-only plans, credits, earned reset credits (including the consume action), plan type and spend control are all visible in the `/codex-usage` report.

## Install

```bash
pi install npm:pi-openai-codex-usage
```

Or from git:

```bash
pi install git:github.com/frederick-wang/pi-openai-codex-usage
```

Requires a Pi `/login` for OpenAI Codex (ChatGPT Plus/Pro subscription OAuth). Never reads the Codex CLI's own auth file.

## Commands

- `/codex-usage` — full report overlay (all buckets, credits, reset credits, plan, spend control, freshness).
- `/codex-usage --json` — stable machine-readable snapshot (English keys only). TUI shows it in the overlay; `print` mode writes it to stdout; other modes refuse.
- `/codex-usage --refresh` — bypass the throttle and fetch immediately.

Reset credits can be consumed from the report: the flow verifies the account identity, asks for confirmation against the option's title/description/expiry, and explains the outcome (this is the only operation in the extension that changes server state).

## Auth & privacy

- Credentials come from Pi's own `openai-codex` auth; the extension never refreshes or writes them, never reads `~/.codex/auth.json`.
- The account id exists in memory only (account-switch detection); it is never logged, persisted, or exported.
- Snapshots persisted to `~/.pi/agent/pi-openai-codex-usage-snapshots.jsonl` contain no tokens, no raw headers, no account id.
- No telemetry; no network other than the usage endpoints.

## Configuration

- `PI_OPENAI_CODEX_USAGE_LANG=zh|en` — UI language (default: locale, then English).

## Notes

- Window labels are derived from the server-reported durations (`5h`, `7d`, …) and can change; they are never hardcoded.
- The usage endpoint is fetched on activation, after settled runs, every 5 minutes while active, and on command — not on a fixed busy poll.
- Where a window is absent from the server response it renders as `n/a`, never as a fake zero.
