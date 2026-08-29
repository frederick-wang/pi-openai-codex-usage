# pi-openai-codex-usage

A pi coding agent extension that surfaces ChatGPT Codex subscription usage in the agent UI while the `openai-codex` provider is active.

## Language

**Limit bucket**:
A metered usage allowance identified by the server-assigned limit id (for example `codex`, `spark`), carrying one or two windows.
_Avoid_: rate limit, quota group, plan

**Window**:
A rolling allowance period inside a bucket: used percent, duration in minutes, reset time. Served on the wire in `primary`/`secondary` slots, which are positions, not semantics.
_Avoid_: 5h limit, weekly limit

**Used percent**:
The server-reported consumption of a window, 0–100.
_Avoid_: usage, fill level

**Remaining percent**:
What the UI shows: `100 − used percent`. Always labeled as remaining.
_Avoid_: left, available percent

**Window label**:
The user-facing name derived from the window's duration (for example `5h`, `7d`), never hardcoded semantics.
_Avoid_: 5-hour limit, weekly

**Active bucket**:
The limit bucket matching the currently active `openai-codex` model, shown in the footer.
_Avoid_: selected bucket, current limit

**Snapshot**:
One normalized reading of the usage API: buckets, credits, reset credits, capture time and freshness. The unit of stale/keep-last-good handling.
_Avoid_: cache entry, reading

**Freshness**:
Whether a snapshot is fresh or stale; stale snapshots render with a `~` marker and are never silently presented as current.
_Avoid_: age, validity

**Credits**:
Purchased balance that continues to fund usage after included limits are exhausted, reported as a decimal string (or unlimited).
_Avoid_: balance, quota

**Reset credit**:
An earned, one-shot right to reset current usage windows, distinct from Credits.
_Avoid_: credit, redeemable, reset

**Redeem request**:
One consume attempt, identified by a freshly generated id and never reused; the server answers with a code plus the number of windows reset.
_Avoid_: action, transaction

**Account identity**:
The ChatGPT account id bound to the runtime token; used only for account-switch detection, never persisted, displayed, or logged.
_Avoid_: user id, account

**Account switch**:
A runtime identity that disagrees with the stored one; any cached state is dropped before refetching.
_Avoid_: re-login, rotation

**Plan type**:
Opaque server string describing the subscription tier; treated as data, never enum-parsed.
_Avoid_: plan level, tier

**Rate limit reached type**:
The server-provided reason a limit was reached (for example quota exhausted, workspace owner credits depleted). Rendered per known kind; unknown kinds get a generic message.
_Avoid_: error reason, limit state
