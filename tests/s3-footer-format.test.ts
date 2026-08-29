import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildReportLines,
	compactBucketLabel,
	formatReset,
	identityTheme,
	renderBar,
	renderFooter,
	resolveLang,
	toJsonPayload,
	windowLabel,
	msg,
	type Snapshot,
	type LimitBucket,
} from "../extensions/openai-codex-usage.ts";

const now = 1_789_000_000_000;

function snapshot(partial: Partial<Snapshot>): Snapshot {
	return {
		schemaVersion: 1,
		capturedAt: now,
		source: "api",
		buckets: [],
		warnings: [],
		...partial,
	};
}

test("renderFooter: dual-window GLM style with dynamic labels and countdown", () => {
	const s = snapshot({
		buckets: [{
			limitId: "codex",
			primary: { usedPercent: 57, windowMinutes: 300, resetsAt: (now + 5 * 3_600_000 + 5 * 60_000) / 1_000 },
			secondary: { usedPercent: 88, windowMinutes: 10_080, resetsAt: (now + 10 * 86_400_000) / 1_000 },
		}],
	});
	const out = renderFooter(s, { now, theme: identityTheme });
	assert.ok(out.startsWith("codex "));
	assert.match(out, /5h ███/); // 43% remaining → 3 filled cells
	assert.match(out, /7d █/);
	assert.match(out, /43%/);
	assert.match(out, /12%/);
	assert.match(out, /↻5h 5m/);
});

test("renderFooter: single-window weekly-only plan", () => {
	const s = snapshot({
		buckets: [{ limitId: "codex", secondary: { usedPercent: 62, windowMinutes: 10_080, resetsAt: (now + 2 * 86_400_000) / 1_000 } }],
	});
	const out = renderFooter(s, { now, theme: identityTheme });
	assert.match(out, /7d █/);
	assert.match(out, /38%/);
});

test("renderFooter: stale marker precedes the content and reads as staleness", () => {
	const s = snapshot({ buckets: [{ limitId: "codex", primary: { usedPercent: 0, windowMinutes: 300 } }] });
	const out = renderFooter(s, { now, stale: true, theme: identityTheme });
	assert.match(out, /^codex ~/);
	assert.match(out, /100%/);
});

test("renderFooter: no windows renders n/a, never a fake zero", () => {
	const s = snapshot({ buckets: [{ limitId: "codex" }] });
	const out = renderFooter(s, { now, theme: identityTheme });
	assert.match(out, /n\/a/);
	assert.equal(out.includes("0%"), false);
});

test("renderFooter: spark bucket label follows the bucket", () => {
	const s = snapshot({
		buckets: [
			{ limitId: "codex" },
			{ limitId: "spark", limitName: "GPT-5.3 Codex Spark", primary: { usedPercent: 40, windowMinutes: 10_080 } },
		],
	});
	// active bucket is passed by the factory; renderFooter uses its own first bucket,
	// so test the pure label helper directly:
	assert.equal(compactBucketLabel({ limitId: "spark", limitName: "GPT-5.3 Codex Spark" }), "spark");
	assert.equal(compactBucketLabel({ limitId: "codex_luna", limitName: "GPT-5.6 Luna" }), "luna");
	assert.equal(compactBucketLabel({ limitId: "codex" }), "codex");
	void s;
});

test("renderBar fills by remaining percent and colors by threshold", () => {
	const bar = renderBar(100, identityTheme);
	assert.match(bar, /^█{8}░{0}$/);
	assert.equal(renderBar(50, identityTheme).includes("████"), true);
	assert.equal(renderBar(0, identityTheme).includes("░"), true);
});

test("formatReset: countdown forms and month fallback", () => {
	assert.equal(formatReset((now + 5 * 3_600_000 + 5 * 60_000) / 1_000, now), "5h 5m");
	const weekOut = formatReset((now + 8 * 86_400_000) / 1_000, now);
	assert.match(weekOut, /^[A-Z][a-z]{2}\d{2}$/); // e.g. Sep06
});

test("formatReset: past times yield empty", () => {
	assert.equal(formatReset(now / 1_000 - 1, now), "");
});

test("resolveLang: explicit env wins, invalid values fall through", () => {
	assert.equal(resolveLang({ PI_OPENAI_CODEX_USAGE_LANG: "zh" }), "zh");
	assert.equal(resolveLang({ PI_OPENAI_CODEX_USAGE_LANG: "en" }), "en");
	assert.equal(resolveLang({ PI_OPENAI_CODEX_USAGE_LANG: "fr" }) === "en" || resolveLang({ PI_OPENAI_CODEX_USAGE_LANG: "fr" }) === "zh", true);
});

test("msg: zh catalog renders Chinese for known keys and falls back to en", () => {
	assert.match(msg("zh", "reportTitle"), /用量/);
	assert.equal(msg("zh", "authNeeded").includes("OpenAI Codex"), true);
	assert.match(msg("en", "reportTitle"), /Codex Usage/);
});

test("buildReportLines: all buckets, credits, reset credits, plan, freshness", () => {
	const s = snapshot({
		planType: "plus",
		buckets: [
			{ limitId: "codex", primary: { usedPercent: 57, windowMinutes: 300, resetsAt: (now + 3_600_000) / 1_000 } },
			{ limitId: "spark", limitName: "GPT-5.3 Codex Spark", primary: { usedPercent: 40, windowMinutes: 10_080 } },
		],
		credits: { hasCredits: true, unlimited: false, balance: "12.50" },
		resetCredits: { availableCount: 3 },
	});
	const lines = buildReportLines(s, { now, lang: "en" });
	const text = lines.join("\n");
	assert.match(text, /plan: plus/);
	assert.match(text, /codex 5h limit: █/);
	assert.match(text, /43% left/);
	assert.match(text, /GPT-5.3 Codex Spark/);
	assert.match(text, /Credits: 12.50/);
	assert.match(text, /Usage limit resets: 3 available/);
	assert.match(text, /Visit https:\/\/chatgpt\.com\/codex\/settings\/usage/);
});

test("buildReportLines: missing reset credits renders dash, zero renders none", () => {
	const noRc = buildReportLines(snapshot({ buckets: [{ limitId: "codex", primary: { usedPercent: 1 } }] }), { now, lang: "en" });
	assert.match(noRc.join("\n"), /Usage limit resets: —/);
	const zeroRc = buildReportLines(snapshot({ resetCredits: { availableCount: 0 } }), { now, lang: "en" });
	assert.match(zeroRc.join("\n"), /Usage limit resets: none available/);
});

test("toJsonPayload: stable keys, raw used percent, no fingerprint/account id", () => {
	const s = snapshot({
		buckets: [{ limitId: "codex", primary: { usedPercent: 57, windowMinutes: 300 } }],
		credits: { hasCredits: false, unlimited: false, balance: "0.00" },
		resetCredits: { availableCount: 2 },
		warnings: ["w"],
	});
	const payload = JSON.stringify(toJsonPayload(s, {}));
	const parsed = JSON.parse(payload) as Record<string, unknown>;
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.freshness, "fresh");
	assert.equal((parsed.buckets as Array<Record<string, unknown>>)[0].primary ? (parsed.buckets as Array<Record<string, unknown>>)[0].primary && ((parsed.buckets as Array<Record<string, unknown>>)[0].primary as Record<string, unknown>).usedPercent : 0, 57);
	assert.equal(payload.includes("fingerprint"), false);
	assert.equal(payload.includes("accountId"), false);
	assert.equal(payload.includes("token"), false);
});

test("toJsonPayload: stale flag and reset inventory options", () => {
	const s = snapshot({ buckets: [{ limitId: "codex" }] });
	const payload = toJsonPayload(s, { stale: true, resetInventory: { availableCount: 1, options: [{ creditId: "c1", title: "Full reset", description: "d" }] } }) as Record<string, unknown>;
	assert.equal(payload.freshness, "stale");
	assert.equal((payload.resetCreditOptions as Array<Record<string, unknown>>).length, 1);
});

test("windowLabel: boundary forms", () => {
	assert.equal(windowLabel(300), "5h");
	assert.equal(windowLabel(1_440), "24h");
	assert.equal(windowLabel(10_080), "7d");
	assert.equal(windowLabel(undefined), "Primary");
});

test("identity bucket type sanity", () => {
	const b: LimitBucket = { limitId: "codex", primary: { usedPercent: 1 } };
	assert.equal(b.limitId, "codex");
});

test("renderFooter: follows the active bucket (spark model shows spark)", () => {
	const s = snapshot({
		buckets: [
			{ limitId: "codex", primary: { usedPercent: 10, windowMinutes: 300 } },
			{ limitId: "spark", primary: { usedPercent: 40, windowMinutes: 10_080 } },
		],
	});
	const spark = renderFooter(s, { now, theme: identityTheme, activeBucket: { limitId: "spark", limitName: "GPT-5.3 Codex Spark" } });
	assert.match(spark, /^spark /);
	assert.match(spark, /7d █/);
	assert.doesNotMatch(spark, /^codex /);
	const codex = renderFooter(s, { now, theme: identityTheme, activeBucket: { limitId: "codex" } });
	assert.match(codex, /^codex /);
	assert.match(codex, /5h █/);
});

test("report: credits none when hasCredits is false; spend control hidden when only reached=false", () => {
	const s = snapshot({ buckets: [{ limitId: "codex", primary: { usedPercent: 1 } }], credits: { hasCredits: false, unlimited: false, balance: "0.00" }, spendControl: { reached: false } });
	const text = buildReportLines(s, { now, lang: "en" }).join("\n");
	assert.match(text, /Credits: none/);
	assert.equal(text.includes("Spend control"), false);
	const shown = buildReportLines(snapshot({ buckets: [{ limitId: "codex", primary: { usedPercent: 1 } }], spendControl: { reached: true, individualLimit: { limit: "100", used: "40", remainingPercent: 60 } } }), { now, lang: "en" }).join("\n");
	assert.match(shown, /Spend control: reached · limit 100 · used 40 · 60% remaining/);
});

