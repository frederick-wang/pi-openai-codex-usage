import assert from "node:assert/strict";
import { test } from "node:test";
import openaiCodexUsage from "../extensions/openai-codex-usage.ts";
import { fakeFetch, fakePi } from "./helpers.ts";

/** S1 scaffold smoke: the stub extension loads, and the host seam records calls. */
test("stub extension default export is a function", () => {
	assert.equal(typeof openaiCodexUsage, "function");
});

test("fakePi records event handlers and commands", () => {
	const pi = fakePi();
	openaiCodexUsage(pi as never);
	assert.equal(Object.keys(pi.handlers).length, 0);
	assert.equal(Object.keys(pi.commands).length, 0);
});

test("fakeFetch records requests and serves queued responses", async () => {
	const fx = fakeFetch([{ status: 200, body: { plan_type: "plus" } }]);
	const res = await fx.fetch("https://example.test/wham/usage", { headers: { Authorization: "Bearer k" } });
	assert.equal(res.status, 200);
	assert.equal(fx.requests.length, 1);
	assert.equal(fx.requests[0].url, "https://example.test/wham/usage");
	assert.deepEqual(await res.json(), { plan_type: "plus" });
});
