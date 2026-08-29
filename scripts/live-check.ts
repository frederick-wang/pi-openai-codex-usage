/**
 * Live verification helper (dev only — excluded from the npm file whitelist).
 *
 * Usage: pnpm run live-check
 *
 * Runs ONE read-only GET /wham/usage with the user's own pi credential
 * (explicitly consented; never runs in CI; no writes, no refresh, no consume).
 * Credentials are read through Pi's public surface only (ADR-0007).
 * Prints a redacted summary. Never prints the token or the account id.
 */

import { buildPiUserAgent, createUsageClient, extractAccountIdFromJwt } from "../extensions/openai-codex-usage.ts";

async function resolveCredential(): Promise<{ token: string; accountId?: string } | undefined> {
	// Preferred: Pi's public credential reader.
	try {
		const mod = (await import("@earendil-works/pi-coding-agent")) as {
			readStoredCredential?: (providerId: string) => { type?: string; access?: string; accountId?: string } | undefined;
		};
		const cred = mod.readStoredCredential?.("openai-codex");
		if (cred?.type === "oauth" && typeof cred.access === "string") {
			return { token: cred.access, accountId: cred.accountId };
		}
	} catch {
		// fall through to CLI
	}
	// Fallback: `pi auth print-bearer-token` (Pi-owned path, no file parsing here).
	try {
		const { execFileSync } = await import("node:child_process");
		const token = execFileSync("pi", ["auth", "print-bearer-token", "--provider", "openai-codex"], { encoding: "utf8" }).trim();
		if (token) return { token, accountId: extractAccountIdFromJwt(token) };
	} catch {
		return undefined;
	}
	return undefined;
}

const cred = await resolveCredential();
if (!cred) {
	console.log("token      : missing (run /login and pick OpenAI Codex)");
	process.exit(1);
}
console.log(`token      : length ${cred.token.length} (not printed)`);

const client = createUsageClient({ fetchImpl: fetch, userAgent: buildPiUserAgent() });
const result = await client.fetchSnapshot(cred.token, cred.accountId ?? "", undefined);

if (result.status === "ok") {
	const s = result.snapshot;
	console.log(`plan       : ${s.planType ?? "?"}`);
	console.log(`source     : ${s.source}`);
	console.log(`capturedAt : ${new Date(s.capturedAt).toISOString()}`);
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
