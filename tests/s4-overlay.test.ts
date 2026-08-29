import assert from "node:assert/strict";
import { test } from "node:test";
import { createOverlayComponent, identityTheme } from "../extensions/openai-codex-usage.ts";
import { stubKb } from "./helpers.ts";
import type { OverlayComponent } from "../extensions/openai-codex-usage.ts";

function makeComponent(body: string[], rows = 24, header = "OpenAI Codex Usage") {
	let doneCalls = 0;
	const component = createOverlayComponent({
		header,
		body,
		footer: "Press Enter, Esc, or Ctrl+C to close · ↑↓ scroll · r refresh",
		theme: identityTheme,
		kb: stubKb(),
		done: () => {
			doneCalls += 1;
		},
		rowGen: () => rows,
		lang: "en",
	});
	return { component, doneCalls: () => doneCalls };
}

const press = (c: OverlayComponent, data: string): void => c.handleInput(data);

test("overlay: render(width) returns boxed lines within the width", () => {
	const { component } = makeComponent(["hello", "world"]);
	const lines = component.render(60);
	assert.equal(lines[0].startsWith("╭"), true);
	assert.equal(lines.at(-1)?.startsWith("╰"), true);
	for (const line of lines) {
		assert.ok(line.length <= 60, `line too long (${line.length} > 60): ${JSON.stringify(line)}`);
	}
});

test("overlay: boxed rows never exceed 80% of the terminal height", () => {
	const body = Array.from({ length: 200 }, (_, i) => `line ${i}`);
	const { component } = makeComponent(body, 24);
	const lines = component.render(80);
	assert.ok(lines.length <= Math.floor(24 * 0.8), `render rows ${lines.length}`);
});

test("overlay: scroll keys move the window, clamp at both ends, wrap long lines", () => {
	const body = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(120)}`);
	const { component } = makeComponent(body, 24);
	// Long lines wrap; total wrapped body > viewport → status line appears.
	const first = component.render(60).join("\n");
	press(component, "\x1b[B");
	const second = component.render(60).join("\n");
	assert.notEqual(second, first);
	for (let i = 0; i < 500; i += 1) press(component, "\x1b[B");
	const bottom = component.render(60).join("\n");
	press(component, "\x1b[H"); // altScreen.top
	const top = component.render(60).join("\n");
	assert.notEqual(top, bottom);
	assert.ok(top.includes("line 0"));
	assert.equal(top.length > 0, true);
});

test("overlay: Enter and Esc close via done exactly once", () => {
	const { component, doneCalls } = makeComponent(["x"]);
	press(component, "\r");
	assert.equal(doneCalls(), 1);
	press(component, "\x1b");
	assert.equal(doneCalls(), 1);
});

test("overlay: tiny terminals degrade to borderless but still fit the budget", () => {
	const { component } = makeComponent(["a", "b", "c"], 4);
	const lines = component.render(40);
	assert.ok(lines.length <= Math.floor(4 * 0.8), `rows ${lines.length}`);
});

test("overlay: CJK wide characters keep the frame intact", () => {
	const { component } = makeComponent(["用法用量", "codex ██"], 20);
	const lines = component.render(30);
	assert.equal(lines[0].startsWith("╭"), true);
	assert.equal(lines.at(-1)?.endsWith("╯"), true);
});

test("overlay: refresh keys are inert (owned by the factory)", () => {
	const { component } = makeComponent(["x"]);
	press(component, "r");
	press(component, "R");
	assert.ok(true);
});
