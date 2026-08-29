/**
 * Live verification helper (dev only — excluded from the npm file whitelist).
 *
 * Usage: pnpm run live-check
 *
 * Runs ONE read-only GET /wham/usage with the user's own pi credential
 * (explicitly consented; never runs in CI; no writes, no refresh, no consume).
 * Prints a redacted summary. Never prints the token or the account id.
 */

import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import { buildPiUserAgent, createUsageClient, piAgentDir } from "../extensions/openai-codex-usage.ts";

const configDir = piAgentDir(process.env as Record<string, string | undefined>, nodeOs.homedir());
const authPath = `${configDir}/auth.json`;

let token: string | undefined;
let accountId: string | undefined;
try {
	const raw = nodeFs.readFileSync(authPath, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const entry = parsed["openai-codex"];
	const e = entry as { type?: string; access?: string; accountId?: string } | undefined;
	if (e?.type === "oauth" && typeof e.access === "string") {
		token = e.access;
		if (typeof e.accountId === "string") accountId = e.accountId;
	}
} catch {
	token = undefined;
}

console.log(`config dir : ${configDir}`);
if (!token) {
	console.log("token      : missing (run /login and pick OpenAI Codex)");
	process.exit(1);
}
console.log(`token      : length ${token.length} (not printed)`);

const client = createUsageClient({ fetchImpl: fetch, userAgent: buildPiUserAgent() });
const result = await client.fetchSnapshot(token, accountId ?? "", undefined);

if (result.status === "ok") {
	const s = result.snapshot;
	console.log(`plan       : ${s.planType ?? "?"}`);
	console.log(`source     : ${s.source}`);
	console.log(`freshness  : ${new Date(s.capturedAt).toISOString()}`);
	if (s.rateLimitReachedType) console.log(`reached    : ${s.rateLimitReachedType}`);
	console.log(`credits    : ${formatCredits(s.credits ?? s.buckets[0]?.credits)}`);
	console.log(`reset rc   : ${s.resetCredits?.availableCount ?? "—"}`);
	if (s.spendControl) console.log(`spend      : ${JSON.stringify(s.spendControl)}`);
	for (const b of s.buckets) {
		const primary = b.primary ? `${b.primary.usedPercent}%·${b.primary.windowMinutes ?? "?"}m·reset@${b.primary.resetsAt ?? "?"}` : "—";
		const secondary = b.secondary ? `${b.secondary.usedPercent}%·${b.secondary.windowMinutes ?? "?"}m·reset@${b.secondary.resetsAt ?? "?"}` : "—";
		console.log(`bucket     : ${b.limitId} (${b.limitName ?? "?"}) primary=${primary} secondary=${secondary}`);
	}
	if (s.warnings.length > 0) {
		console.log("warnings   :");
		for (const w of s.warnings) console.log(`  - ${w}`);
	}
	console.log("schema     : ok — normalizer accepted the live payload");
	process.exit(s.warnings.some((w) => w.toLowerCase().includes("skipped")) ? 2 : 0);
}
if (result.status === "retry") {
	console.log(`quota      : retry after ${result.retryAfterMs} ms`);
	process.exit(1);
}
console.log(`quota      : ${result.message}`);
process.exit(1);

function formatCredits(credits: { hasCredits: boolean; unlimited: boolean; balance?: string } | undefined): string {
	if (!credits) return "—";
	if (credits.unlimited) return "unlimited";
	return credits.balance?.trim() ? credits.balance : credits.hasCredits ? "available" : "none";
}
