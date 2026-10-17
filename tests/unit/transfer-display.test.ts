import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptTransferState, transferFinished, transferPercent } from "../../apps/desktop/src/renderer/src/lib/transfer-display.ts";
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
  for (const state of ["completed", "failed", "cancelled"] as const) assert.equal(transferFinished({ state }), true);
  for (const state of ["queued", "running", "cancelling"] as const) assert.equal(transferFinished({ state }), false);
});
