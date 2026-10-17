import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_SNIPPET_BODY_BYTES, type CatalogSnippet, type CatalogTag } from "../../packages/contracts/src/index.ts";
import { bodyBytes, bodyError, filterSnippets, saveFieldError, sizeText } from "../../apps/desktop/src/renderer/src/lib/snippet-filter.ts";

const tags: CatalogTag[] = [
  { id: "00000000-0000-4000-8000-000000000001", revision: 1, label: "Production" },
  { id: "00000000-0000-4000-8000-000000000002", revision: 1, label: "ฐานข้อมูล" },
];
const snippets: CatalogSnippet[] = [
  { id: "10000000-0000-4000-8000-000000000001", revision: 1, label: "Deploy web", tagIds: [tags[0]!.id] },
  { id: "10000000-0000-4000-8000-000000000002", revision: 1, label: "สำรองข้อมูล", tagIds: [tags[1]!.id] },
  { id: "10000000-0000-4000-8000-000000000003", revision: 1, label: "Cafe\u0301 logs", tagIds: [] },
];

test("snippet search matches every term against labels and tag labels only, NFC and case-insensitively", () => {
  const ids = (search: string) => filterSnippets(snippets, tags, search).map((row) => row.label);
  assert.deepEqual(ids(""), ["Deploy web", "สำรองข้อมูล", "Cafe\u0301 logs"]);
  assert.deepEqual(ids("  DEPLOY "), ["Deploy web"]);
  assert.deepEqual(ids("production"), ["Deploy web"]);
  assert.deepEqual(ids("deploy prod"), ["Deploy web"]);
  assert.deepEqual(ids("deploy ฐาน"), []);
  assert.deepEqual(ids("ฐานข้อมูล"), ["สำรองข้อมูล"]);
  assert.deepEqual(ids("ข้อมูล"), ["สำรองข้อมูล"]);
  assert.deepEqual(ids("caf\u00e9"), ["Cafe\u0301 logs"]);
  // Bodies are never part of the projection, so they cannot be searched.
  assert.deepEqual(ids("echo"), []);
});

test("body checks: UTF-8 size, 1 MiB bound, lone surrogates; typed save problems map to fields", () => {
  assert.equal(bodyBytes(""), 0);
  assert.equal(bodyBytes("ก\r\n🚀"), 3 + 2 + 4);
  assert.equal(bodyError("a".repeat(MAX_SNIPPET_BODY_BYTES)), undefined);
  assert.match(bodyError("a".repeat(MAX_SNIPPET_BODY_BYTES + 1))!, /1 MiB/);
  assert.match(bodyError("ก".repeat(400_000))!, /1 MiB/);
  assert.match(bodyError("x\uD800y")!, /broken character/);
  assert.equal(bodyError("emoji 🚀 ok"), undefined);
  assert.equal(saveFieldError({ status: "invalid", field: "label", code: "empty" }).field, "label");
  assert.equal(saveFieldError({ status: "invalid", field: "body", code: "too-large" }).field, "body");
  assert.equal(saveFieldError({ status: "invalid", field: "tag", code: "not-found" }).field, "tag");
  assert.equal(sizeText(1), "1 byte");
  assert.equal(sizeText(1536), "1.5 KiB");
});
