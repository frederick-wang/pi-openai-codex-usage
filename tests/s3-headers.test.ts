import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeHeaderUpdate, parseRateLimitHeaders, type Snapshot } from "../extensions/openai-codex-usage.ts";

const now = 1_789_000_000_000;

function snapshot(): Snapshot {
	return {
		schemaVersion: 1,
		capturedAt: now,
		source: "api",
		buckets: [{
			limitId: "codex",
			primary: { usedPercent: 43, windowMinutes: 300, resetsAt: 1_789_100_000 },
			secondary: { usedPercent: 12, windowMinutes: 10_080, resetsAt: 1_789_500_000 },
		}],
		warnings: [],
	};
}

test("parseRateLimitHeaders: official codex family with secondary + name", () => {
	const update = parseRateLimitHeaders({
		"x-codex-primary-used-percent": "12.5",
		"x-codex-primary-window-minutes": "60",
		"x-codex-primary-reset-at": "1704069000",
		"x-codex-secondary-used-percent": "80",
		"x-codex-secondary-window-minutes": "1440",
		"x-codex-secondary-reset-at": "1704074400",
		"x-codex-limit-name": "Codex",
	}, now);
	assert.ok(update);
	assert.equal(update.buckets.length, 1);
	assert.equal(update.buckets[0].limitId, "codex");
	assert.equal(update.buckets[0].primary?.usedPercent, 12.5);
	assert.equal(update.buckets[0].primary?.windowMinutes, 60);
	assert.equal(update.buckets[0].primary?.resetsAt, 1_704_069_000);
	assert.equal(update.buckets[0].secondary?.usedPercent, 80);
	assert.equal(update.buckets[0].limitName, "Codex");
});

test("parseRateLimitHeaders: discovers new limit families from primary-used-percent", () => {
	const update = parseRateLimitHeaders({
		"x-codex-bengalfox-primary-used-percent": "80",
		"x-codex-bengalfox-limit-name": "gpt-5.2-codex-sonic",
	}, now);
	assert.ok(update);
	// codex family has no data → only the discovered family remains.
	assert.equal(update.buckets.length, 1);
	assert.equal(update.buckets[0].limitId, "codex_bengalfox");
});

test("parseRateLimitHeaders: reset-after-seconds compat and credits", () => {
	const update = parseRateLimitHeaders({
		"x-codex-primary-used-percent": "40",
		"x-codex-primary-reset-after-seconds": "3600",
		"x-codex-credits-has-credits": "true",
		"x-codex-credits-unlimited": "false",
		"x-codex-credits-balance": "7.25",
	}, now);
	assert.ok(update);
	const codex = update.buckets.find((b) => b.limitId === "codex");
	assert.equal(codex?.primary?.resetsAt, Math.round(now / 1_000) + 3_600);
	assert.equal(codex?.credits?.hasCredits, true);
	assert.equal(codex?.credits?.balance, "7.25");
});

test("parseRateLimitHeaders: no recognized family yields undefined", () => {
	assert.equal(parseRateLimitHeaders({ "content-type": "application/json" }, now), undefined);
});

test("mergeHeaderUpdate: field-wise, present wins, freshness untouched", () => {
	const s = snapshot();
	const update = parseRateLimitHeaders({
		"x-codex-primary-used-percent": "80", // window minutes/resetsAt absent → keep
	}, now)!;
	const merged = mergeHeaderUpdate(s, update);
	assert.equal(merged.buckets[0].primary?.usedPercent, 80);
	assert.equal(merged.buckets[0].primary?.windowMinutes, 300); // kept
	assert.equal(merged.buckets[0].primary?.resetsAt, 1_789_100_000); // kept
	assert.equal(merged.buckets[0].secondary?.usedPercent, 12); // untouched
	assert.equal(merged.capturedAt, s.capturedAt);
	assert.equal(merged.source, "api");
});

test("mergeHeaderUpdate: unknown bucket ids never introduced", () => {
	const s = snapshot();
	const update = parseRateLimitHeaders({
		"x-codex_stranger-primary-used-percent": "99",
	}, now)!;
	const merged = mergeHeaderUpdate(s, update);
	assert.deepEqual(merged.buckets.map((b) => b.limitId), ["codex"]);
});
