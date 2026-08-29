import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accountFingerprint,
	buildPiUserAgent,
	normalizeLimitId,
	normalizeResetCreditsListPayload,
	normalizeWhamPayload,
	redactError,
	selectActiveBucket,
	parseRetryAfter,
	UsageError,
	windowLabel,
} from "../extensions/openai-codex-usage.ts";

const SEC = 1_000;
const now = 1_789_000_000 * 1_000; // fixed capturedAt (ms)

const fullPayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 43, limit_window_seconds: 18_000, reset_at: 1_789_100_000 },
		secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_after_seconds: 123_456 },
	},
	credits: { has_credits: true, unlimited: false, balance: "12.50" },
	additional_rate_limits: [
		{
			metered_feature: "spark",
			limit_name: "GPT-5.3 Codex Spark",
			rate_limit: { primary_window: { used_percent: 62, limit_window_seconds: 604_800, reset_at: 1_789_050_000 } },
		},
	],
	spend_control: {
		reached: false,
		individual_limit: { limit: "100", used: "43", remaining_percent: 57, reset_after_seconds: 3_600, reset_at: 1_789_000_000 },
	},
	rate_limit_reached_type: { kind: "rate_limit_reached" },
	rate_limit_reset_credits: { available_count: 3 },
};

test("normalizeWhamPayload: full payload maps every section", () => {
	const s = normalizeWhamPayload(fullPayload, now);
	assert.equal(s.schemaVersion, 1);
	assert.equal(s.planType, "plus");
	assert.equal(s.rateLimitReachedType, "rate_limit_reached");
	assert.equal(s.limitReached, undefined);
	assert.equal(s.credits?.hasCredits, true);
	assert.equal(s.credits?.balance, "12.50");
	assert.equal(s.resetCredits?.availableCount, 3);
	assert.deepEqual(s.spendControl, {
		reached: false,
		individualLimit: { limit: "100", used: "43", remainingPercent: 57, resetsAt: 1_789_000_000 },
	});
	assert.equal(s.buckets.length, 2);
	assert.equal(s.buckets[0].limitId, "codex");
	assert.equal(s.buckets[0].primary?.usedPercent, 43);
	assert.equal(s.buckets[0].primary?.windowMinutes, 300);
	assert.equal(s.buckets[0].primary?.resetsAt, 1_789_100_000);
	assert.equal(s.buckets[0].secondary?.resetsAt, now / 1_000 + 123_456);
	assert.equal(s.buckets[1].limitId, "spark");
	assert.equal(s.buckets[1].limitName, "GPT-5.3 Codex Spark");
	assert.deepEqual(s.warnings, []);
});

test("normalizeWhamPayload: string encodings, clamping, seconds-vs-ms", () => {
	const payload = {
		rate_limit: {
			primary_window: { used_percent: "150", limit_window_seconds: "18000", reset_at: 1_789_100_000_000 },
			secondary_window: { used_percent: "-5", limit_window_seconds: 604_800, reset_at: 1_789_050_000 },
		},
	};
	const s = normalizeWhamPayload(payload, now);
	assert.equal(s.buckets[0].primary?.usedPercent, 100); // clamped
	assert.equal(s.buckets[0].primary?.windowMinutes, 300); // string seconds accepted
	assert.equal(s.buckets[0].primary?.resetsAt, 1_789_100_000); // ms input converted to seconds
	assert.equal(s.buckets[0].secondary?.usedPercent, 0);
	assert.equal(s.buckets[0].secondary?.windowMinutes, 10_080);
});

test("windowLabel derives labels from minutes", () => {
	assert.equal(windowLabel(60), "1h");
	assert.equal(windowLabel(300), "5h");
	assert.equal(windowLabel(1_440), "24h");
	assert.equal(windowLabel(10_080), "7d");
	assert.equal(windowLabel(43_200), "30d");
	assert.equal(windowLabel(90), "90m");
	assert.equal(windowLabel(undefined), "Primary");
	assert.equal(windowLabel(0), "Primary");
});

test("normalizeWhamPayload: missing reset credits is absent, never zero", () => {
	const s = normalizeWhamPayload({ rate_limit: { primary_window: { used_percent: 1 } } }, now);
	assert.equal(s.resetCredits, undefined);
	assert.equal(s.buckets[0].limitId, "codex");
});

test("normalizeWhamPayload: no rate_limit synthesizes an empty codex bucket", () => {
	const s = normalizeWhamPayload({
		additional_rate_limits: [{ metered_feature: "spark", limit_name: "Spark", rate_limit: { primary_window: { used_percent: 10 } } }],
	}, now);
	assert.equal(s.buckets[0].limitId, "codex");
	assert.equal(s.buckets[0].primary, undefined);
	assert.equal(s.buckets.length, 2);
});

test("normalizeWhamPayload: duplicate normalized ids merge with a warning", () => {
	const payload = {
		additional_rate_limits: [
			{ metered_feature: "spark", limit_name: "Spark", rate_limit: { primary_window: { used_percent: 10 } } },
			{ metered_feature: "spark", limit_name: "Spark Pro", rate_limit: { primary_window: { used_percent: 20 } } },
		],
	};
	const s = normalizeWhamPayload(payload, now);
	const sparks = s.buckets.filter((b) => b.limitId === "spark");
	assert.equal(sparks.length, 1);
	assert.equal(sparks[0].primary?.usedPercent, 20); // last wins
	assert.ok(s.warnings.some((w) => w.includes("duplicate")));
});

test("normalizeWhamPayload: hostile strings sanitized", () => {
	const payload = {
		additional_rate_limits: [{
			metered_feature: "spark",
			limit_name: "spark\x1b[31mevil\x1b[0m".repeat(10),
			rate_limit: { primary_window: { used_percent: 5 } },
		}],
	};
	const s = normalizeWhamPayload(payload, now);
	assert.equal(s.buckets[1].limitName?.includes("\x1b"), false);
	assert.ok((s.buckets[1].limitName?.length ?? 0) <= 160);
});

test("normalizeWhamPayload: unknown plan type and reached kind pass through", () => {
	const s = normalizeWhamPayload(
		{ plan_type: "prolite", rate_limit_reached_type: { kind: "brand_new_kind" }, rate_limit: { primary_window: { used_percent: 1 } } },
		now,
	);
	assert.equal(s.planType, "prolite");
	assert.equal(s.rateLimitReachedType, "brand_new_kind");
});

test("normalizeWhamPayload: non-object payload throws UsageError parse", () => {
	for (const bad of [null, 42, "str", []]) {
		assert.throws(() => normalizeWhamPayload(bad as never, now), (e: unknown) => e instanceof UsageError && e.code === "parse");
	}
});

test("selectActiveBucket: exact token, variant token, codex, first", () => {
	const buckets = [
		{ limitId: "codex", limitName: "Codex" },
		{ limitId: "spark", limitName: "GPT-5.3 Codex Spark" },
		{ limitId: "codex_luna", limitName: "GPT-5.6 Luna" },
	] as never;
	assert.equal(selectActiveBucket(buckets, { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" })?.limitId, "spark");
	assert.equal(selectActiveBucket(buckets, { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" })?.limitId, "codex_luna");
	assert.equal(selectActiveBucket(buckets, { id: "gpt-5.5", name: "GPT-5.5" })?.limitId, "codex");
	assert.equal(selectActiveBucket([buckets[1], buckets[2]] as never, { id: "unknown-model", name: "X" })?.limitId, "spark");
	assert.equal(selectActiveBucket([] as never, { id: "any", name: "Any" }), undefined);
});

test("normalizeResetCreditsListPayload: filters and caps options", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({
		id: `credit-${i}`,
		reset_type: "codex_rate_limits",
		status: "available",
		granted_at: "2026-08-20T00:00:00Z",
		expires_at: `2026-08-${String(21 + (i % 5)).padStart(2, "0")}T00:00:00Z`,
		title: `Reset ${i}`,
		description: `desc ${i}`,
	}));
	const out = normalizeResetCreditsListPayload({ available_count: 40, credits: many });
	assert.equal(out.availableCount, 40);
	assert.equal(out.options.length, 32); // capped
	assert.equal(out.options[0].creditId, "credit-0"); // expiry-sorted
	assert.equal(out.options[0].title, "Reset 0");
	assert.equal(typeof out.options[0].expiresAt, "number");
});

test("normalizeResetCreditsListPayload: non-available and other reset types excluded; generic fallback", () => {
	const out = normalizeResetCreditsListPayload({
		available_count: 1,
		credits: [
			{ id: "x", reset_type: "codex_rate_limits", status: "redeemed", granted_at: "2026-08-20T00:00:00Z" },
			{ id: "y", reset_type: "other_type", status: "available", granted_at: "2026-08-20T00:00:00Z" },
		],
	});
	assert.equal(out.availableCount, 1);
	// Neither unavailable option leaked; the count>0-with-no-options fallback is the generic reset.
	assert.equal(out.options.length, 1);
	assert.equal(out.options[0].title, "Full reset");
	assert.equal(out.options[0].creditId, undefined);
	const fallback = normalizeResetCreditsListPayload({ available_count: 2, credits: [] });
	assert.equal(fallback.options.length, 1);
	assert.equal(fallback.options[0].creditId, undefined);
	assert.equal(fallback.options[0].title, "Full reset");
});

test("accountFingerprint: deterministic, 16 hex chars, not the account id", () => {
	const a = accountFingerprint("acc-123");
	assert.equal(a, accountFingerprint("acc-123"));
	assert.equal(a.length, 16);
	assert.match(a, /^[0-9a-f]{16}$/);
	assert.notEqual(a, "acc-123");
	assert.notEqual(accountFingerprint("acc-123"), accountFingerprint("acc-124"));
});

test("buildPiUserAgent mirrors the pi UA shape", () => {
	const ua = buildPiUserAgent();
	assert.match(ua, /^pi \([^)]*\)$/);
	assert.ok(ua.startsWith("pi ("));
});

test("redactError hides bearer tokens and custom secrets", () => {
	const msg = redactError("failed with Bearer abc.def.ghi and secret-42", ["secret-42"]);
	assert.equal(msg, "failed with Bearer <redacted-Bearer> and <redacted>");
});

test("parseRetryAfter: seconds, HTTP date, garbage default, cap", () => {
	const nowMs = 1_752_000_000_000;
	assert.equal(parseRetryAfter("120", nowMs), 120_000);
	assert.equal(parseRetryAfter(new Date(nowMs + 60_000).toUTCString(), nowMs), 60_000);
	assert.equal(parseRetryAfter("garbage", nowMs), 60_000);
	assert.equal(parseRetryAfter("9999999", nowMs), 15 * 60_000); // capped
});

test("normalizeLimitId normalizes case and dashes", () => {
	assert.equal(normalizeLimitId("Codex-Spark"), "codex_spark");
	assert.equal(normalizeLimitId("codex"), "codex");
});
