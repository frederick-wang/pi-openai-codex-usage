import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_ID, USAGE_URL, createUsageClient } from "../extensions/openai-codex-usage.ts";
import { fakeFetch, fakePi } from "./helpers.ts";

/** S1 scaffold smoke: the pipeline module loads and the host seam records calls. */
test("pipeline module exposes the provider contract", () => {
	assert.equal(PROVIDER_ID, "openai-codex");
	assert.equal(USAGE_URL, "https://chatgpt.com/backend-api/wham/usage");
});

test("fakePi records event handlers and commands", () => {
	const pi = fakePi();
	assert.equal(Object.keys(pi.handlers).length, 0);
	assert.equal(Object.keys(pi.commands).length, 0);
});

test("fakeFetch records requests and serves queued responses", async () => {
	const fx = fakeFetch([{ status: 200, body: { plan_type: "plus" } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("tok", "acc", undefined);
	assert.equal(res.status, "ok");
	assert.equal(fx.requests.length, 1);
	assert.equal(fx.requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
});
