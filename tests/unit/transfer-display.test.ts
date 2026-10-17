import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptTransferState, transferCanCancel, transferCanRetry, transferFinished, transferPercent, transferRenameProblem } from "../../apps/desktop/src/renderer/src/lib/transfer-display.ts";
import type { TransferState } from "../../packages/contracts/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const state = (sequence: number, override = {}): TransferState => ({ owner, sequence, jobs: [], ...override });

test("transfer events fence old owners and late initial snapshots", () => {
  assert.equal(acceptTransferState(undefined, state(0), owner), true);
  assert.equal(acceptTransferState(state(2), state(1), owner), false);
  assert.equal(acceptTransferState(state(2), state(2), owner), false);
  assert.equal(acceptTransferState(state(2), state(3), owner), true);
  assert.equal(acceptTransferState(undefined, state(4, { owner: { ...owner, generation: 2 } }), owner), false);
  assert.equal(acceptTransferState(undefined, state(4, { owner: { ...owner, windowId: 2 } }), owner), false);
});

test("confirmed writes never display 100 percent until completion including zero byte and unknown files", () => {
  assert.equal(transferPercent({ state: "running", bytes: 5, total: 10 }), 50);
  assert.equal(transferPercent({ state: "running", bytes: 10, total: 10 }), 99);
  assert.equal(transferPercent({ state: "failed", bytes: 10, total: 10 }), 99);
  assert.equal(transferPercent({ state: "running", bytes: 11, total: 10 }), 99);
  assert.equal(transferPercent({ state: "running", bytes: 0, total: 0 }), null);
  assert.equal(transferPercent({ state: "running", bytes: 5, total: null }), null);
  assert.equal(transferPercent({ state: "completed", bytes: 0, total: 0 }), 100);
  assert.equal(transferPercent({ state: "completed", bytes: 5, total: null }), 100);
});

test("clear-finished eligibility excludes queued and cancelling work", () => {
  for (const state of ["completed", "failed", "cancelled", "skipped"] as const) assert.equal(transferFinished({ state }), true);
  for (const state of ["queued", "running", "cancelling", "conflict", "publishing"] as const) assert.equal(transferFinished({ state }), false);
});

test("publishing stays below completion and skipped/conflict jobs have no percent", () => {
  assert.equal(transferPercent({ state: "publishing", bytes: 10, total: 10 }), 99);
  assert.equal(transferPercent({ state: "publishing", bytes: 0, total: 0 }), null);
  assert.equal(transferPercent({ state: "skipped", bytes: 10, total: 10 }), null);
  assert.equal(transferPercent({ state: "conflict", bytes: 10, total: 10 }), null);
});

test("publishing cannot be cancelled and uncertain publication cannot be retried", () => {
  for (const state of ["queued", "running", "conflict"] as const) assert.equal(transferCanCancel({ state }), true);
  for (const state of ["publishing", "cancelling", "completed", "failed", "cancelled", "skipped"] as const)
    assert.equal(transferCanCancel({ state }), false);
  assert.equal(transferCanRetry({ state: "failed", error: "no-space" }), true);
  assert.equal(transferCanRetry({ state: "cancelled", error: "cancelled" }), true);
  assert.equal(transferCanRetry({ state: "failed", error: "publication-unknown" }), false);
  for (const state of ["queued", "running", "conflict", "publishing", "cancelling", "completed", "skipped"] as const)
    assert.equal(transferCanRetry({ state, error: null }), false);
});

test("rename validates raw basenames without trimming or normalizing spaces and Unicode", () => {
  for (const name of ["", ".", "..", "a/b", "a\0b", "\uFFFD", "\uD800", "a".repeat(1025), "ท".repeat(342)])
    assert.notEqual(transferRenameProblem(name), null, JSON.stringify(name));
  for (const name of [" report ", " ", "..report", "e\u0301.txt", "é.txt", "ภาษาไทย.txt", "ท".repeat(341), "a".repeat(1024)])
    assert.equal(transferRenameProblem(name), null, JSON.stringify(name));
});
