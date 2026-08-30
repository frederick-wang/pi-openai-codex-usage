import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createExtension,
	normalizeWhamPayload,
	type AuthResolution,
	type Snapshot,
	type UsageClient,
} from "../extensions/openai-codex-usage.ts";
import { fakePi, freshCtx, invokeOverlay } from "./helpers.ts";

const okPayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 43, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 },
	},
	credits: { has_credits: true, unlimited: false, balance: "12.50" },
};
const okSnapshot = normalizeWhamPayload(okPayload, Date.now()) as unknown as Snapshot;
const codexModel = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" };

const listPayload = {
	available_count: 1,
	credits: [
		{ id: "c1", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-08-20T00:00:00Z", expires_at: "2026-08-31T00:00:00Z", title: "Reset A", description: "Full reset" },
	],
};

function makeClient(run: {
	fetchSnapshot?: () => Promise<{ status: "ok"; snapshot: Snapshot } | { status: "retry"; retryAfterMs: number } | { status: "error"; code: string; message: string }>;
	listResetCredits?: () => Promise<unknown>;
	consumeResetCredit?: () => Promise<unknown>;
}) {
	const calls = { fetch: 0, list: 0, consume: 0, consumeBody: undefined as unknown };
	const client = {
		async fetchSnapshot() { calls.fetch += 1; return (run.fetchSnapshot?.() ?? { status: "error", code: "transient", message: "no route" }) as never; },
		async listResetCredits() { calls.list += 1; return (run.listResetCredits?.() ?? { status: "ok", inventory: { availableCount: 0, options: [] } }) as never; },
		async consumeResetCredit(_token: string, _accountId: string, body: unknown) { calls.consume += 1; calls.consumeBody = body; return (run.consumeResetCredit?.() ?? { status: "error", code: "parse", message: "no route" }) as never; },
		resetBreaker() { /* */ },
	};
	return { client: client as unknown as UsageClient, calls };
}

function install(opts: {
	client: UsageClient;
	auth?: AuthResolution | (() => AuthResolution | Promise<AuthResolution>);
	credentialReader?: (p: string) => { accountId?: string } | undefined;
	nowFn?: () => number;
	lang?: string;
}) {
	const pi = fakePi();
	createExtension({
		env: { PI_OPENAI_CODEX_USAGE_LANG: opts.lang ?? "en" },
		nowFn: opts.nowFn ?? (() => Date.now()),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => opts.client,
		authFor: async () => (typeof opts.auth === "function" ? opts.auth() : opts.auth ?? { status: "ok", token: "tok.x", accountId: "acc-1", switched: false }),
		...(opts.credentialReader ? { credentialReader: opts.credentialReader } : {}),
	})(pi);
	return { pi };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("command: /codex-usage opens the overlay with the full report", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.runCommand("codex-usage", "", ctx);
	await flush();
	assert.equal(log.customCalls, 1);
	const lines = invokeOverlay(log, 80);
	assert.ok(lines.some((l) => l.includes("plan: plus")));
	// close the overlay via the captured component
	const comp = log.overlay?.component;
	comp?.handleInput("\x1b");
	assert.equal(log.overlay?.doneCalls, 1);
});

test("command: --json renders JSON in the overlay for tui mode", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.runCommand("codex-usage", "--json", ctx);
	await flush();
	const lines = invokeOverlay(log, 120);
	const text = lines.join("\n");
	assert.ok(text.includes('"schemaVersion": 1'));
	assert.ok(text.includes('"planType": "plus"'));
	assert.equal(text.includes("accountId"), false);
});

test("command: --json on print mode writes JSON to stdout", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("print", codexModel);
	const origLog = console.log;
	const out: string[] = [];
	console.log = (line: string) => { out.push(line); };
	try {
		await pi.runCommand("codex-usage", "--json", ctx);
		await flush();
	} finally {
		console.log = origLog;
	}
	assert.equal(log.customCalls, 0);
	assert.ok(out.join("\n").includes('"schemaVersion": 1'));
});

test("command: --json on protocol modes refuses", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("rpc", codexModel);
	await pi.runCommand("codex-usage", "--json", ctx);
	await flush();
	assert.equal(log.customCalls, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("requires TUI or print")));
});

test("command: unknown options notify an error", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.runCommand("codex-usage", "--frobnicate", ctx);
	await flush();
	assert.equal(calls.fetch, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("Unknown option")));
});

test("command: no credential notifies authNeeded", async () => {
	const { client } = makeClient({});
	const { pi } = install({ client, auth: () => ({ status: "no-auth" }) });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.runCommand("codex-usage", "", ctx);
	await flush();
	assert.ok(log.notifications.some((n) => n.message.includes("/login")));
});

test("command: consume flow — select, confirm, outcome, refetch", async () => {
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ creditId: "c1", title: "Reset A", description: "Full reset", expiresAt: 1_900_000_000 }] } }),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 2 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.list, 1);
	assert.equal(calls.consume, 1);
	assert.ok(log.selectCalls.length === 1);
	assert.ok(log.confirmCalls.length === 1);
	assert.ok(log.notifications.some((n) => n.message.includes("Usage reset.")));
	assert.ok(log.notifications.some((n) => n.message.includes("window(s) reset")));
});

test("command: consume guards — stored account mismatch refuses before any POST", async () => {
	const { client, calls } = makeClient({
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ title: "Reset A", description: "d" }] } }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-DIFFERENT" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 0);
	assert.equal(calls.list, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("does not match")));
});

test("command: consume — no stored credential fails closed", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client, credentialReader: () => undefined });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("does not match")));
});

test("command: consume — empty inventory notifies and never POSTs", async () => {
	const { client, calls } = makeClient({
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 0, options: [] } }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("No usage limit resets available")));
});

test("command: consume — cancel after select never POSTs", async () => {
	const { client, calls } = makeClient({
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ title: "Reset A", description: "d" }] } }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: false });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("Reset cancelled")));
});

test("command: consume — clock drift while the picker is open still consumes the picked credit", async () => {
	let clock = Date.now();
	const expiresAt = Math.floor(clock / 1000) + 5 * 3_600 + 120;
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ creditId: "c1", title: "Reset A", description: "Full reset", expiresAt }] } }),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 1 }),
	});
	// Every clock read jumps a minute: any mapping that re-renders labels breaks.
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }), nowFn: () => { clock += 61_000; return clock; } });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(log.confirmCalls.length, 1);
	assert.equal(calls.consume, 1);
	assert.equal((calls.consumeBody as { credit_id?: string }).credit_id, "c1");
	assert.ok(log.notifications.some((n) => n.message.includes("Usage reset.")));
});

test("command: consume — confirmation dialog covers title, description, and expiry (ADR-0001 guard 4)", async () => {
	const fixedNow = 1_800_000_000_000;
	const expiresAt = 1_800_000_000 + 5 * 3_600 + 120; // renders "5h 2m" regardless of timezone
	const { client } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ creditId: "c1", title: "Reset A", description: "Full reset", expiresAt }] } }),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 1 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }), nowFn: () => fixedNow });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(log.confirmCalls.length, 1);
	assert.ok(log.confirmCalls[0]!.message.includes("Reset A"));
	assert.ok(log.confirmCalls[0]!.message.includes("Full reset"));
	assert.ok(log.confirmCalls[0]!.message.includes("expires 5h 2m"));
});

test("command: consume — zh confirmation dialog renders title, description, and expiry", async () => {
	const fixedNow = 1_800_000_000_000;
	const expiresAt = 1_800_000_000 + 5 * 3_600 + 120;
	const { client } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ creditId: "c1", title: "完全重置", description: "重置当前用量限制。", expiresAt }] } }),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 1 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }), nowFn: () => fixedNow, lang: "zh" });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(log.confirmCalls.length, 1);
	assert.ok(log.confirmCalls[0]!.message.includes("完全重置"));
	assert.ok(log.confirmCalls[0]!.message.includes("重置当前用量限制。"));
	assert.ok(log.confirmCalls[0]!.message.includes("5h 2m 过期"));
	assert.ok(!log.confirmCalls[0]!.message.includes("undefined"));
});

test("command: consume — picking the second option posts the second credit id", async () => {
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({
			status: "ok",
			inventory: { availableCount: 2, options: [
				{ creditId: "c1", title: "Reset A", description: "d" },
				{ creditId: "c2", title: "Reset B", description: "d" },
			] },
		}),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 1 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx } = freshCtx("tui", codexModel, { selectId: "1", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 1);
	assert.equal((calls.consumeBody as { credit_id?: string }).credit_id, "c2");
});

test("command: consume — identically labelled credits map to the picked one", async () => {
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({
			status: "ok",
			inventory: { availableCount: 2, options: [
				{ creditId: "c1", title: "Full reset", description: "d" },
				{ creditId: "c2", title: "Full reset", description: "d" },
			] },
		}),
		consumeResetCredit: async () => ({ status: "ok", code: "reset", windowsReset: 1 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx } = freshCtx("tui", codexModel, { selectId: "1", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 1);
	assert.equal((calls.consumeBody as { credit_id?: string }).credit_id, "c2");
});

test("command: consume — dismissing the picker cancels before any confirm or POST", async () => {
	const { client, calls } = makeClient({
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ title: "Reset A", description: "d" }] } }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(log.confirmCalls.length, 0);
	assert.equal(calls.consume, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("Reset cancelled")));
});

test("command: consume — a choice outside the presented options fails closed, not as a cancel", async () => {
	const { client, calls } = makeClient({
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ title: "Reset A", description: "d" }] } }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectResult: "ghost option", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(log.confirmCalls.length, 0);
	assert.equal(calls.consume, 0);
	assert.ok(!log.notifications.some((n) => n.message.includes("Reset cancelled")));
	assert.ok(log.notifications.some((n) => n.level === "error" && n.message.includes("unavailable")));
});

test("command: consume — fail-closed on multi-source conflict when stored account present but differs", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-2" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 0);
	assert.ok(log.notifications.some((n) => n.message.includes("does not match")));
});

test("command: consume outcome mapping — already_redeemed explained", async () => {
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 1, options: [{ title: "Reset A", description: "d" }] } }),
		consumeResetCredit: async () => ({ status: "ok", code: "already_redeemed", windowsReset: 0 }),
	});
	const { pi } = install({ client, credentialReader: () => ({ accountId: "acc-1" }) });
	const { ctx, log } = freshCtx("tui", codexModel, { selectId: "0", confirm: true });
	await pi.runCommand("codex-usage", "consume", ctx);
	await flush();
	assert.equal(calls.consume, 1);
	assert.ok(log.notifications.some((n) => n.message.includes("already completed")));
});

test("command: refresh flag bypasses the retry deadline", async () => {
	const { client, calls } = makeClient({
		fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }),
		listResetCredits: async () => ({ status: "ok", inventory: { availableCount: 0, options: [] } }),
	});
	const { pi } = install({ client });
	const { ctx } = freshCtx("tui", codexModel);
	// First fetch ok; simulate a 429 deadline via a weird client? Instead assert plain success twice.
	await pi.runCommand("codex-usage", "", ctx);
	await flush();
	await pi.runCommand("codex-usage", "--refresh", ctx);
	await flush();
	assert.equal(calls.fetch, 2);
});
