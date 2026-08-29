import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAlerts, type Snapshot } from "../extensions/openai-codex-usage.ts";

const snap = (reached?: string): Snapshot => ({
	schemaVersion: 1,
	capturedAt: 1,
	source: "api",
	buckets: [],
	warnings: [],
	...(reached ? { rateLimitReachedType: reached } : {}),
});

test("alerts: auth-invalid transition fires once, re-arms when healthy", () => {
	const first = evaluateAlerts(null, { snapshot: snap(), authInvalid: true });
	assert.equal(first.emitted.length, 1);
	assert.equal(first.emitted[0].kind, "auth-invalid");
	const second = evaluateAlerts(first.state, { snapshot: snap(), authInvalid: true });
	assert.equal(second.emitted.length, 0);
	const healed = evaluateAlerts(second.state, { snapshot: snap(), authInvalid: false });
	assert.equal(healed.emitted.length, 0);
	const again = evaluateAlerts(healed.state, { snapshot: snap(), authInvalid: true });
	assert.equal(again.emitted.length, 1);
});

test("alerts: reached-type transition with kind-aware copy, change re-fires", () => {
	const first = evaluateAlerts(null, { snapshot: snap("rate_limit_reached"), authInvalid: false });
	assert.equal(first.emitted.length, 1);
	assert.equal(first.emitted[0].messageKey, "alertReachedLimit");
	const same = evaluateAlerts(first.state, { snapshot: snap("rate_limit_reached"), authInvalid: false });
	assert.equal(same.emitted.length, 0);
	const changed = evaluateAlerts(same.state, { snapshot: snap("workspace_owner_credits_depleted"), authInvalid: false });
	assert.equal(changed.emitted[0].messageKey, "alertReachedOwnerCredits");
	const cleared = evaluateAlerts(changed.state, { snapshot: snap(), authInvalid: false });
	assert.equal(cleared.emitted.length, 0);
	const again = evaluateAlerts(cleared.state, { snapshot: snap("rate_limit_reached"), authInvalid: false });
	assert.equal(again.emitted.length, 1);
});

test("alerts: unknown kinds get the generic message with the raw kind", () => {
	const { emitted } = evaluateAlerts(null, { snapshot: snap("brand_new_kind"), authInvalid: false });
	assert.equal(emitted[0].messageKey, "alertReachedUnknown");
	assert.equal(emitted[0].vars?.kind, "brand_new_kind");
});

test("alerts: account switch resets state (fresh null evaluates again)", () => {
	const first = evaluateAlerts(null, { snapshot: snap("rate_limit_reached"), authInvalid: false });
	const second = evaluateAlerts(null, { snapshot: snap("rate_limit_reached"), authInvalid: false });
	assert.equal(first.emitted.length, 1);
	assert.equal(second.emitted.length, 1);
});
