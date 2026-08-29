# 0006 — Window names are derived from the server duration, never hardcoded

`primary` and `secondary` are wire slots, not semantics. A window's display label comes from its duration (`5h`, `24h`, `7d`, `30d`, …); when the duration is absent the label falls back to "Primary"/"Secondary". Hardcoded "5h"/"weekly" naming is rejected because the server's window durations are under the provider's control and have changed before. Duration-derived labels are also DST-safe.
