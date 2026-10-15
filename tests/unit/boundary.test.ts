import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  WindowBoundary,
  sameDocument,
  type SenderIdentity,
} from "../../apps/desktop/src/main/boundary.ts";
import type {
  Owner,
  Result,
  StorageHealth,
  WindowStateEvent,
} from "../../packages/contracts/src/index.ts";

const entry = "file:///app/renderer/index.html";
function fixture(
  id = 1,
  windowId = id,
  health: StorageHealth = { status: "ready", schemaVersion: 1 },
) {
  let destroyed = false;
  const frame = { url: entry };
  const sender = { id, mainFrame: frame, isDestroyed: () => destroyed };
  const events: WindowStateEvent[] = [];
  const boundary = new WindowBoundary(
    entry,
    { name: "ssterm", version: "0.1.0", platform: "darwin" },
    () => health,
  );
  const revoke = boundary.register(sender, windowId, false, (event) =>
    events.push(event),
  );
  const event = { sender, senderFrame: frame };
  const initial = boundary.bootstrap(event, []);
  assert.equal(initial.ok, true);
  const owner = initial.ok ? initial.value.owner : assert.fail("missing owner");
  return {
    boundary,
    sender,
    frame,
    events,
    revoke,
    event,
    owner,
    destroy: () => {
      destroyed = true;
    },
  };
}
function code(value: Result<unknown>, expected: string) {
  assert.equal(value.ok, false);
  if (!value.ok) assert.equal(value.error.code, expected);
}
const ping = (owner: Owner) => ({ owner, requestId: "check_1" });

test("bootstrap and ping return only bounded serializable application state", () => {
  const { boundary, event, owner } = fixture();
  assert.deepEqual(boundary.bootstrap(event, []), {
    ok: true,
    value: {
      app: { name: "ssterm", version: "0.1.0", platform: "darwin" },
      owner,
      window: { focused: false, sequence: 0 },
      storage: { status: "ready", schemaVersion: 1 },
    },
  });
  assert.deepEqual(boundary.ping(event, [ping(owner)]), {
    ok: true,
    value: { requestId: "check_1", ready: true },
  });
  code(boundary.bootstrap(event, [{}]), "invalid-request");
});

test("bootstrap copies validated storage health and never accepts diagnostic details", () => {
  const health: StorageHealth = { status: "blocked", code: "corrupt" };
  const { boundary, event } = fixture(1, 1, health);
  const result = boundary.bootstrap(event, []);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.value.storage, health);
    assert.notEqual(result.value.storage, health);
    health.code = "busy";
    assert.deepEqual(result.value.storage, { status: "blocked", code: "corrupt" });
  }
  Object.assign(health, { message: "/private/path/row" });
  code(boundary.bootstrap(event, []), "unavailable");
});

test("registered sender identity and main frame are checked before payloads", () => {
  const { boundary, event, owner, sender } = fixture();
  const wrongSender: SenderIdentity = { ...sender };
  for (const badEvent of [
    { sender: wrongSender, senderFrame: wrongSender.mainFrame },
    { sender: { ...sender, id: 888 }, senderFrame: sender.mainFrame },
    { sender, senderFrame: { url: entry } },
    { sender, senderFrame: null },
  ]) {
    code(boundary.ping(badEvent, [null]), "unauthorized");
    code(boundary.bootstrap(badEvent, []), "unauthorized");
  }
  assert.equal(boundary.ping(event, [ping(owner)]).ok, true);
});

test("wrong file, query, origin and protocol do not inherit document authority", () => {
  const { boundary, event, frame, owner } = fixture();
  for (const url of [
    "file:///other/index.html",
    `${entry}?extra=true`,
    "https://example.com/",
    "http://127.0.0.1:5173/",
    "data:text/html,hi",
    "not a URL",
  ]) {
    frame.url = url;
    code(boundary.ping(event, [ping(owner)]), "unauthorized");
  }
  frame.url = `${entry}#showcase`;
  assert.equal(boundary.ping(event, [ping(owner)]).ok, true);
  assert.equal(
    sameDocument("file:///app/renderer/index.html/extra", entry),
    false,
  );
});

test("payload rejects unknown keys, invalid bounds, owners and argument arity", () => {
  const { boundary, event, owner } = fixture();
  const invalid = [
    null,
    [],
    {},
    { ...ping(owner), extra: true },
    { ...ping(owner), owner: { ...owner, extra: 1 } },
    { ...ping(owner), requestId: "" },
    { ...ping(owner), requestId: "a".repeat(65) },
    { ...ping(owner), requestId: "../path" },
    { ...ping(owner), requestId: 3 },
    { ...ping(owner), owner: { ...owner, generation: NaN } },
    { ...ping(owner), owner: { ...owner, generation: Infinity } },
    { ...ping(owner), owner: { ...owner, generation: -1 } },
    { ...ping(owner), owner: { ...owner, generation: 1.2 } },
    { ...ping(owner), owner: { ...owner, windowId: 0 } },
    {
      ...ping(owner),
      owner: { ...owner, generation: Number.MAX_SAFE_INTEGER + 1 },
    },
  ];
  for (const value of invalid)
    code(boundary.ping(event, [value]), "invalid-request");
  code(boundary.ping(event, []), "invalid-request");
  code(boundary.ping(event, [ping(owner), "extra"]), "invalid-request");
  code(boundary.ping(event, [ping({ ...owner, windowId: 2 })]), "unauthorized");
  code(
    boundary.ping(event, [
      ping({ ...owner, generation: owner.generation + 1 }),
    ]),
    "stale-owner",
  );
});

test("cross-window owner, reload and destroy invalidate old requests", () => {
  const { boundary, event, sender, owner, revoke, destroy } = fixture();
  const otherFrame = { url: entry };
  const other = { id: 2, mainFrame: otherFrame, isDestroyed: () => false };
  boundary.register(other, 2, false, () => {});
  code(
    boundary.ping({ sender: other, senderFrame: otherFrame }, [ping(owner)]),
    "unauthorized",
  );
  boundary.rotate(sender);
  code(boundary.ping(event, [ping(owner)]), "stale-owner");
  const next = boundary.bootstrap(event, []);
  assert.equal(next.ok, true);
  if (next.ok) {
    assert.ok(next.value.owner.generation > owner.generation);
    assert.equal(boundary.ping(event, [ping(next.value.owner)]).ok, true);
  }
  destroy();
  code(boundary.bootstrap(event, []), "unauthorized");
  revoke();
  revoke();
  code(boundary.bootstrap(event, []), "unauthorized");
});

test("focus is ordered, duplicate states suppressed, disposal is idempotent", () => {
  const { boundary, sender, event, events, owner } = fixture();
  boundary.focus(sender, true);
  boundary.focus(sender, true);
  boundary.focus(sender, false);
  assert.deepEqual(events, [
    { owner, sequence: 1, type: "focus-changed", focused: true },
    { owner, sequence: 2, type: "focus-changed", focused: false },
  ]);
  boundary.rotate(sender);
  boundary.focus(sender, true);
  assert.equal(events[2]?.sequence, 1);
  assert.notEqual(events[2]?.owner.generation, owner.generation);
  boundary.dispose();
  boundary.dispose();
  boundary.focus(sender, false);
  assert.equal(events.length, 3);
  code(boundary.bootstrap(event, []), "unavailable");
});
