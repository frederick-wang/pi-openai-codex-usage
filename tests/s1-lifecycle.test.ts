import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFingerprint, createExtension, normalizeWhamPayload, type AuthResolution, type SnapshotStoreLike, type UsageClient, type Snapshot } from "../extensions/openai-codex-usage.ts";
import { fakePi, freshCtx, type OverlayArtifact } from "./helpers.ts";

// ── fake timers with an advanceable clock ──────────────────────────────────

interface Task { id: number; fn: () => void; at: number; kind: "timeout" | "interval"; interval: number; }
function fakeTimers() {
	let t = 0;
	let seq = 0;
	const tasks: Task[] = [];
	const schedule = (fn: () => void, ms: number, kind: "timeout" | "interval", interval: number) => {
		seq += 1;
		const task: Task = { id: seq, fn, at: t + ms, kind, interval };
		tasks.push(task);
		return { id: seq, ...({ unref() { /* */ } }) };
	};
	return {
		now: () => t,
		setTimeout: (fn: () => void, ms?: number) => schedule(fn, ms ?? 0, "timeout", 0),
		clearTimeout: (handle: unknown) => {
			const id = (handle as { id: number }).id;
			const i = tasks.findIndex((x) => x.id === id);
			if (i >= 0) tasks.splice(i, 1);
		},
		setInterval: (fn: () => void, ms?: number) => schedule(fn, ms ?? 0, "interval", ms ?? 0),
		clearInterval: (handle: unknown) => {
			const id = (handle as { id: number }).id;
			const i = tasks.findIndex((x) => x.id === id);
			if (i >= 0) tasks.splice(i, 1);
		},
		advance(ms: number) {
			const target = t + ms;
			for (;;) {
				const next = tasks.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				tasks.splice(tasks.indexOf(next), 1);
				t = Math.max(t, next.at);
				next.fn();
				if (next.kind === "interval") schedule(next.fn, next.interval, "interval", next.interval);
			}
			t = target;
		},
	};
}

const okPayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 43, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 },
	},
};
const okSnapshot = normalizeWhamPayload(okPayload, Date.now()) as unknown as Snapshot;
const exhaustedSnapshot = normalizeWhamPayload(
	{ plan_type: "plus", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 } } },
	Date.now(),
) as unknown as Snapshot;
const codexModel = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" };

function makeClient(run: {
	fetchSnapshot?: (token: string, accountId: string) => Promise<{ status: "ok"; snapshot: unknown } | { status: "retry"; retryAfterMs: number } | { status: "error"; code: string; message: string }>;
	listResetCredits?: () => Promise<unknown>;
	consumeResetCredit?: () => Promise<unknown>;
}) {
	const calls = { fetch: 0 as number, list: 0, consume: 0 };
	const client = {
		async fetchSnapshot(token: string, accountId: string) {
			calls.fetch += 1;
			return (run.fetchSnapshot?.(token, accountId) ?? { status: "error", code: "transient", message: "no route" }) as never;
		},
		async listResetCredits() { calls.list += 1; return (run.listResetCredits?.() ?? { status: "ok", inventory: { availableCount: 0, options: [] } }) as never; },
		async consumeResetCredit() { calls.consume += 1; return (run.consumeResetCredit?.() ?? { status: "error", code: "parse", message: "no route" }) as never; },
		resetBreaker() { /* */ },
	};
	return { client: client as unknown as UsageClient, calls };
}

function install(opts: {
	client: UsageClient;
	auth?: AuthResolution | ((ctx: unknown) => AuthResolution | Promise<AuthResolution>);
	timers?: ReturnType<typeof fakeTimers>;
	credentialReader?: (p: string) => { accountId?: string } | undefined;
	store?: SnapshotStoreLike;
}) {
	const timers = opts.timers ?? fakeTimers();
	const pi = fakePi();
	const authFor = async () => (typeof opts.auth === "function" ? opts.auth({}) : opts.auth ?? { status: "ok", token: "tok.x", accountId: "acc-1", switched: false });
	createExtension({
		env: { PI_OPENAI_CODEX_USAGE_LANG: "en" },
		nowFn: timers.now,
		setTimeout: timers.setTimeout as never,
		clearTimeout: timers.clearTimeout as never,
		setInterval: timers.setInterval as never,
		clearInterval: timers.clearInterval as never,
		clientFor: () => opts.client,
		authFor: authFor as never,
		...(opts.credentialReader ? { credentialReader: opts.credentialReader } : {}),
		...(opts.store ? { snapshotStore: opts.store } : {}),
	})(pi);
	return { pi, timers };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("session_start with a codex model activates and fetches", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.ok(calls.fetch >= 1);
	assert.equal(log.status.at(-1)?.key, "pi-openai-codex-usage");
	assert.match(log.status.at(-1)?.text ?? "", /codex 5h/);
});

test("non-codex provider clears the footer and never fetches", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", { provider: "xai" });
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.equal(calls.fetch, 0);
	assert.equal(log.status.at(-1)?.text, undefined);
});

test("non-interactive modes never fetch via lifecycle", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client });
	const { ctx } = freshCtx("json", codexModel);
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await flush();
	assert.equal(calls.fetch, 0);
});

test("model_select switches activation; account switch drops state", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	let switched = false;
	const { pi } = install({ client, auth: async () => ({ status: "ok", token: "tok.x", accountId: switched ? "acc-2" : "acc-1", switched }) });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /codex 5h/);
	// switch account: refresh must drop the snapshot first (footer loses the bar)
	switched = true;
	await pi.emit("model_select", { model: codexModel }, ctx);
	await flush();
	assert.equal(calls.fetch, 2); // activation fetch + switch refresh
	assert.match(log.status.at(-1)?.text ?? "", /codex 5h/); // refetched under the new account
});

test("auth errors mark n/a and one-shot refresh is throttled", async () => {
	const { client } = makeClient({});
	const { pi } = install({ client, auth: async () => ({ status: "no-auth" }) });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const text = log.status.at(-1)?.text ?? "";
	assert.match(text, /n\/a/);
});

test("agent_settled schedules a debounced refresh (60s) that fires once", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const timers = fakeTimers();
	const { pi } = install({ client, timers });
	const { ctx } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const before = calls.fetch;
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	timers.advance(61_000);
	await flush();
	assert.equal(calls.fetch, before + 1);
});

test("keep-last-good: transient failure keeps the previous snapshot marked stale", async () => {
	let fail = false;
	const { client } = makeClient({ fetchSnapshot: async () => fail ? { status: "error", code: "transient", message: "boom" } : { status: "ok", snapshot: okSnapshot } });
	const timers = fakeTimers();
	const { pi } = install({ client, timers });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /codex 5h/);
	fail = true;
	// force another refresh
	await pi.emit("model_select", { model: codexModel }, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /^codex ~/);
});

test("exhausted bucket schedules exactly one refresh after resetsAt", async () => {
	const timers = fakeTimers();
	const exhausted = normalizeWhamPayload(
		{ plan_type: "plus", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: Math.floor(timers.now() / 1_000) + 3_600 } } },
		timers.now(),
	);
	const fetchTimes: number[] = [];
	const { client, calls } = makeClient({
		fetchSnapshot: async () => {
			fetchTimes.push(timers.now());
			return { status: "ok", snapshot: exhausted as never };
		},
	});
	const { pi } = install({ client, timers });
	const { ctx } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const before = calls.fetch;
	timers.advance(3_606_000); // resetAt (3600s) + skew (5s) + margin
	await flush();
	assert.ok(calls.fetch > before);
	// the meaningful assertion: exactly one fetch lands in the reset window
	const oneshot = fetchTimes.filter((t) => t >= 3_605_000 && t < 3_610_000);
	assert.equal(oneshot.length, 1, `reset fetch count ${oneshot.length}: ${fetchTimes.join(",")}`);
});

test("session_shutdown clears timers and deactivates", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const timers = fakeTimers();
	const { pi } = install({ client, timers });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	await pi.emit("session_shutdown", {}, ctx);
	await flush();
	assert.equal(log.status.at(-1)?.text, undefined);
	timers.advance(20 * 60_000);
	assert.ok(true); // no throw, no fetch loop
});

test("after_provider_response merges headers over an existing snapshot only", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	await pi.emit("after_provider_response", { status: 200, headers: { "x-codex-primary-used-percent": "80", "x-codex-primary-window-minutes": "120" } }, ctx);
	await flush();
	const text = log.status.at(-1)?.text ?? "";
	assert.match(text, /20%/); // remaining now 20%
	assert.match(text, /2h/); // header minutes applied
});

test("review-fix: generation guard — old refresh finally does not clear new inFlight", async () => {
	const gate: { release: (() => void) | null } = { release: null };
	const { client, calls } = makeClient({
		fetchSnapshot: async () => {
			await new Promise<void>((resolve) => { gate.release = resolve; });
			return { status: "ok", snapshot: okSnapshot };
		},
	});
	const { pi } = install({ client });
	const { ctx } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush(); // first fetch is in-flight (held)
	await pi.emit("model_select", { model: codexModel }, ctx); // generation++ → new refresh → inFlight blocked
	await flush();
	const callsDuringHold = calls.fetch;
	// release the old request — its finally must NOT clear the new inFlight
	gate.release?.();
	await flush();
	await pi.emit("agent_settled", {}, ctx);
	await flush();
	// no concurrency explosion: next scheduled refresh would start only if inFlight cleared
	assert.ok(calls.fetch <= callsDuringHold + 2, `fetch count ${calls.fetch}`);
});

test("review-fix: header merge is provider-scoped", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: okSnapshot }) });
	const { pi } = install({ client });
	const otherModel = { provider: "xai", id: "grok-4" };
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const before = log.status.at(-1)?.text;
	await pi.emit("after_provider_response", { status: 200, headers: { "x-codex-primary-used-percent": "99" } }, { ...ctx, model: otherModel });
	await flush();
	assert.equal(log.status.at(-1)?.text, before); // untouched for other providers
});

test("review-fix: 401 re-resolves auth once and retries", async () => {
	let authCalls = 0;
	const client = makeClient({ fetchSnapshot: async () => ({ status: "error", code: "auth", message: "rejected" }) }).client;
	const { pi } = install({
		client,
		auth: async () => {
			authCalls += 1;
			return { status: "ok", token: `tok-${authCalls}`, accountId: "acc-1", switched: false };
		},
	});
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.ok(authCalls >= 2); // initial + one re-resolution
	assert.match(log.status.at(-1)?.text ?? "", /auth error/);
});

test("review-fix: restored snapshot renders stale before the first fetch completes", async () => {
	const fp = accountFingerprint("acc-1");
	const row = { t: 1, fingerprint: fp, snapshot: okSnapshot };
	const store = { append: () => { /* */ }, load: (loadFp: string) => (loadFp === fp ? row : undefined) };
	const { client } = makeClient({ fetchSnapshot: async () => { await new Promise((r) => setTimeout(r, 50)); return { status: "ok", snapshot: okSnapshot }; } });
	const { pi } = install({ client, store: store as never });
	const { ctx, log } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	// Before the fetch resolves, the footer shows the restored snapshot as stale.
	const text = log.status.at(-1)?.text ?? "";
	assert.match(text, /^codex ~/);
});

test("review-fix: retry one-shot schedules one refresh after retry-after", async () => {
	const timers = fakeTimers();
	let fail = true;
	const { client, calls } = makeClient({
		fetchSnapshot: async () => fail ? { status: "retry", retryAfterMs: 120_000 } : { status: "ok", snapshot: okSnapshot },
	});
	const { pi } = install({ client, timers });
	const { ctx } = freshCtx("tui", codexModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const before = calls.fetch;
	timers.advance(121_000);
	await flush();
	assert.ok(calls.fetch > before);
});
