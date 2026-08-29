import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createUsageClient,
	extractAccountIdFromJwt,
	resolveCodexAuth,
	UsageError,
} from "../extensions/openai-codex-usage.ts";
import { fakeFetch } from "./helpers.ts";
import type { CtxLike, CredentialReader } from "../extensions/openai-codex-usage.ts";

const okPayload = {
	plan_type: "plus",
	rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_789_100_000 } },
};

function authCtx(token: string): { ctx: CtxLike; getProviderAuthCalls: number } {
	let calls = 0;
	const ctx = {
		modelRegistry: {
			getProviderAuth: async () => {
				calls += 1;
				return { auth: { apiKey: token } };
			},
		},
	} as unknown as CtxLike;
	return { ctx, getProviderAuthCalls: () => calls } as never;
}

test("client: sends the agreed headers and parses a snapshot", async () => {
	const fx = fakeFetch([{ status: 200, body: okPayload }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("tok.abc", "acc-1", undefined);
	assert.equal(res.status, "ok");
	const req = fx.requests[0];
	assert.equal(req.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(req.headers["Authorization"], "Bearer tok.abc");
	assert.equal(req.headers["ChatGPT-Account-Id"], "acc-1");
	assert.match(String(req.headers["User-Agent"]), /^pi \(/);
	assert.equal((res as { status: string }).status, "ok");
});

test("client: redirect is manual", async () => {
	const fx = fakeFetch([{ status: 200, body: okPayload }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	await client.fetchSnapshot("t", "a", undefined);
	assert.equal(fx.requests[0].fetchInit?.redirect ?? "manual", "manual");
});

test("client: 401/403 classify as auth", async () => {
	for (const status of [401, 403]) {
		const fx = fakeFetch([{ status, body: { error: "nope" } }]);
		const client = createUsageClient({ fetchImpl: fx.fetch });
		const res = await client.fetchSnapshot("t", "a", undefined);
		assert.equal(res.status, "error");
		assert.equal((res as { code: string }).code, "auth");
	}
});

test("client: 429 with Retry-After seconds or HTTP date", async () => {
	const fx = fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "120" } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch, nowFn: () => 1_752_000_000_000 });
	const res = await client.fetchSnapshot("t", "a", undefined);
	assert.equal(res.status, "retry");
	assert.equal((res as { retryAfterMs: number }).retryAfterMs, 120_000);
});

test("client: 429 body resets_at used when no header", async () => {
	const nowMs = 1_752_000_000_000;
	const resetsAt = Math.floor(nowMs / 1000) + 300;
	const fx = fakeFetch([{ status: 429, body: { error: { resets_at: resetsAt } }, headers: {} }]);
	const client = createUsageClient({ fetchImpl: fx.fetch, nowFn: () => nowMs });
	const res = await client.fetchSnapshot("t", "a", undefined);
	assert.equal(res.status, "retry");
	assert.equal((res as { retryAfterMs: number }).retryAfterMs, 300_000);
});

test("client: 5xx and network errors are transient", async () => {
	const fx = fakeFetch([{ status: 500, body: {} }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("t", "a", undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { code: string }).code, "transient");
});

test("client: oversized body is a parse error", async () => {
	const big = "x".repeat(300 * 1024);
	const fx = fakeFetch([{ status: 200, body: big }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("t", "a", undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { code: string }).code, "parse");
});

test("client: breaker opens after 3 consecutive hard failures and recovers on probe", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return new Response("boom", { status: 500 });
	};
	const client = createUsageClient({ fetchImpl: fetchImpl as never });
	for (let i = 0; i < 3; i += 1) {
		const res = await client.fetchSnapshot("t", "a", undefined);
		assert.equal((res as { code: string }).code, "transient");
	}
	const res = await client.fetchSnapshot("t", "a", undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { code: string }).code, "breaker");
	assert.equal(calls, 3); // no fetch while suspended
	client.resetBreaker();
	await client.fetchSnapshot("t", "a", undefined);
	assert.equal(calls, 4);
});

test("client: error messages redact the bearer token", async () => {
	const fetchImpl = async () => {
		throw new Error("socket error for tok.secret12345");
	};
	const client = createUsageClient({ fetchImpl: fetchImpl as never });
	const res = await client.fetchSnapshot("tok.secret12345", "a", undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { message: string }).message.includes("tok.secret12345"), false);
});

test("auth: accepts both nested and direct JWT claim shapes", () => {
	const mk = (payload: object) => {
		const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
		return `h.${b64}.sig`;
	};
	assert.equal(extractAccountIdFromJwt(mk({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" } })), "acc-nested");
	assert.equal(extractAccountIdFromJwt(mk({ "https://api.openai.com/auth.chatgpt_account_id": "acc-direct" })), "acc-direct");
	assert.equal(extractAccountIdFromJwt("not.a.jwt"), undefined);
	assert.equal(extractAccountIdFromJwt(mk({})), undefined);
	assert.equal(extractAccountIdFromJwt("a.b"), undefined);
});

test("auth: resolveCodexAuth states", async () => {
	// no-auth: getProviderAuth returns nothing
	const noAuth = await resolveCodexAuth({ modelRegistry: { getProviderAuth: async () => undefined } } as never, {});
	assert.equal(noAuth.status, "no-auth");
	// auth-error: getProviderAuth throws
	const err = await resolveCodexAuth({ modelRegistry: { getProviderAuth: async () => { throw new Error("boom"); } } } as never, {});
	assert.equal(err.status, "auth-error");
	// ok with switch detection (JWT vs stored mismatch)
	const token = mkJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-rt" } });
	const reader: CredentialReader = () => ({ accountId: "acc-stored" });
	const switched = await resolveCodexAuth(
		{ modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: token } }) } } as never,
		{ credentialReader: reader },
	);
	assert.equal(switched.status, "ok");
	assert.equal((switched as { switched: boolean }).switched, true);
	// ok without switch when stored matches
	const same = await resolveCodexAuth(
		{ modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: token } }) } } as never,
		{ credentialReader: () => ({ accountId: "acc-rt" }) },
	);
	assert.equal((same as { switched: boolean }).switched, false);
});

function mkJwt(payload: object): string {
	const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `h.${b64}.sig`;
}

test("UsageError carries code", () => {
	const e = new UsageError("parse", "bad");
	assert.equal(e.code, "parse");
	assert.equal(e.message, "bad");
});
