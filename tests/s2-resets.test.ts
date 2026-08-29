import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageClient } from "../extensions/openai-codex-usage.ts";
import { fakeFetch } from "./helpers.ts";

const listPayload = {
	available_count: 2,
	credits: [
		{ id: "c1", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-08-20T00:00:00Z", expires_at: "2026-08-31T00:00:00Z", title: "Reset A", description: "dA" },
		{ id: "c2", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-08-20T00:00:00Z", title: "Reset B", description: "dB" },
	],
};

test("client: listResetCredits parses the inventory with auth headers", async () => {
	const fx = fakeFetch([{ status: 200, body: listPayload }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.listResetCredits("tok.x", "acc-1", undefined);
	assert.equal(res.status, "ok");
	const inv = (res as { inventory: { availableCount: number; options: unknown[] } }).inventory;
	assert.equal(inv.availableCount, 2);
	assert.equal(inv.options.length, 2);
	const req = fx.requests[0];
	assert.equal(req.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(req.headers["Authorization"], "Bearer tok.x");
	assert.equal(req.fetchInit?.method, "GET");
	assert.equal(req.fetchInit?.redirect, "manual");
});

test("client: consumeResetCredit POSTs redeem id and maps the outcome", async () => {
	const fx = fakeFetch([{ status: 200, body: { code: "reset", windows_reset: 2 } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.consumeResetCredit("tok.x", "acc-1", { redeem_request_id: "rid-1", credit_id: "c1" }, undefined);
	assert.equal(res.status, "ok");
	assert.equal((res as { code: string }).code, "reset");
	assert.equal((res as { windowsReset: number }).windowsReset, 2);
	const req = fx.requests[0];
	assert.equal(req.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
	assert.equal(req.fetchInit?.method, "POST");
	assert.deepEqual(JSON.parse(String(req.fetchInit?.body)), { redeem_request_id: "rid-1", credit_id: "c1" });
});

test("client: consume without a credit id omits the field", async () => {
	const fx = fakeFetch([{ status: 200, body: { code: "nothing_to_reset", windows_reset: 0 } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.consumeResetCredit("tok.x", "acc-1", { redeem_request_id: "rid-2" }, undefined);
	assert.equal(res.status, "ok");
	assert.equal((res as { code: string }).code, "nothing_to_reset");
	const body = JSON.parse(String(fx.requests[0].fetchInit?.body)) as Record<string, unknown>;
	assert.equal(body.credit_id, undefined);
	assert.equal(body.redeem_request_id, "rid-2");
});

test("client: all outcome codes map; unknown codes are parse errors", async () => {
	for (const code of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"]) {
		const fx = fakeFetch([{ status: 200, body: { code, windows_reset: 1 } }]);
		const client = createUsageClient({ fetchImpl: fx.fetch });
		const res = await client.consumeResetCredit("t", "a", { redeem_request_id: "r" }, undefined);
		assert.equal(res.status, "ok");
		assert.equal((res as { code: string }).code, code);
	}
	const fx = fakeFetch([{ status: 200, body: { code: "something_new" } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.consumeResetCredit("t", "a", { redeem_request_id: "r" }, undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { code: string }).code, "parse");
});

test("client: reset endpoints classify 401/429/5xx", async () => {
	// 401 list
	let fx = fakeFetch([{ status: 401, body: {} }]);
	let client = createUsageClient({ fetchImpl: fx.fetch });
	let listRes = await client.listResetCredits("t", "a", undefined);
	assert.equal(listRes.status, "error");
	assert.equal((listRes as { code: string }).code, "auth");
	// 429 consume
	fx = fakeFetch([{ status: 429, body: {} }]);
	client = createUsageClient({ fetchImpl: fx.fetch });
	let consumeRes = await client.consumeResetCredit("t", "a", { redeem_request_id: "r" }, undefined);
	assert.equal(consumeRes.status, "retry");
	// 5xx list
	fx = fakeFetch([{ status: 502, body: {} }]);
	client = createUsageClient({ fetchImpl: fx.fetch });
	listRes = await client.listResetCredits("t", "a", undefined);
	assert.equal(listRes.status, "error");
	assert.equal((listRes as { code: string }).code, "transient");
});
