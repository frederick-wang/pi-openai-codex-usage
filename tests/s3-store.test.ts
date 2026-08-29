import assert from "node:assert/strict";
import { test } from "node:test";
import { createSnapshotStore, SNAPSHOT_COMPACT_AT, type Snapshot } from "../extensions/openai-codex-usage.ts";

function memIo() {
	const files = new Map<string, string>();
	return {
		readFile: (p: string) => files.get(p) ?? null,
		appendFile: (p: string, s: string) => files.set(p, (files.get(p) ?? "") + s),
		writeFile: (p: string, s: string) => files.set(p, s),
		rename: (from: string, to: string) => files.set(to, files.get(from) ?? ""),
		mkdir: () => { /* */ },
		files,
	};
}

const snap = (id: string): Snapshot => ({ schemaVersion: 1, capturedAt: 1, source: "api", buckets: [{ limitId: id }], warnings: [] });

test("store: append and load by fingerprint", () => {
	const io = memIo();
	const store = createSnapshotStore("/fake", io);
	store.append({ t: 1, fingerprint: "fp1", snapshot: snap("codex") });
	store.append({ t: 2, fingerprint: "fp2", snapshot: snap("spark") });
	assert.equal(store.load("fp1")?.snapshot.buckets[0].limitId, "codex");
	assert.equal(store.load("fp2")?.snapshot.buckets[0].limitId, "spark");
	assert.equal(store.load("missing"), undefined);
});

test("store: corrupt lines are skipped", () => {
	const io = memIo();
	io.appendFile("x", "{not-json}\n");
	io.writeFile("/fake/pi-openai-codex-usage-snapshots.jsonl", io.files.get("x") ?? "");
	const store = createSnapshotStore("/fake", io);
	assert.equal(store.load("fp1"), undefined);
});

test("store: hygiene skips rows carrying token/accountid/authorization fields", () => {
	const io = memIo();
	const store = createSnapshotStore("/fake", io);
	// Direct write of a poisoned row that mimics a leaked snapshot.
	io.writeFile(
		"/fake/pi-openai-codex-usage-snapshots.jsonl",
		JSON.stringify({ t: 1, fingerprint: "fp1", snapshot: { capturedAt: 1, accountId: "leak" } }) + "\n",
	);
	assert.equal(store.load("fp1"), undefined);
});

test("store: compaction keeps the last SNAPSHOT_KEEP rows", () => {
	const io = memIo();
	const store = createSnapshotStore("/fake", io);
	for (let i = 0; i < SNAPSHOT_COMPACT_AT + 20; i += 1) {
		store.append({ t: i, fingerprint: "fp", snapshot: snap(`b${i}`) });
	}
	const row = store.load("fp");
	assert.equal(row?.snapshot.buckets[0].limitId, `b${SNAPSHOT_COMPACT_AT + 19}`);
	const raw = io.files.get("/fake/pi-openai-codex-usage-snapshots.jsonl") ?? "";
	assert.ok(raw.split("\n").filter(Boolean).length <= SNAPSHOT_COMPACT_AT + 1);
});
