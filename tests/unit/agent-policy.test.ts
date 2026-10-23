import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeCommand, parsePlan, takePlanCommand, unshowable, type PlanEntry } from "../../apps/desktop/src/main/agent-policy.ts";
import { isDecideAgentRequest, isSetAgentModeRequest } from "../../packages/contracts/src/index.ts";

const plan = (...commands: string[]): PlanEntry[] => commands.map((command) => ({ command, ran: false }));

test("plan matching is exact after trimming surrounding spaces and tabs only; adversarial near-matches never match", () => {
  assert.equal(normalizeCommand(" \t apt-get update \t "), "apt-get update");
  assert.equal(normalizeCommand(" apt-get update"), " apt-get update", "only U+0020 and tab are trimmed");
  const entries = plan("systemctl restart nginx");
  for (const near of [
    "systemctl restart nginx; rm -rf /", "systemctl restart nginx && rm -rf /", "systemctl restart nginx || true", "systemctl restart nginx | sh",
    "systemctl restart nginx #", "systemctl  restart nginx", "systemctl restart  nginx", "Systemctl restart nginx", "systemctl restart nginx2",
    "'systemctl' restart nginx", "systemctl restart 'nginx'", "systemctl restart \"nginx\"", "systemctl\trestart nginx", "systemctl restart nginx\n",
    "systemctl restart nginx\r", "systemctl restart nginx ", "systemctl restart nginx", "systemctl restart nginх", // Cyrillic х
    "systemctl restart nginx​", "‮systemctl restart nginx", "systemctl restart nginx﻿", "sudo systemctl restart nginx",
    "systemctl restart ngin", "", " ",
  ]) assert.equal(takePlanCommand(entries, near), undefined, JSON.stringify(near));
  assert.equal(entries[0]!.ran, false, "near-matches consume nothing");
  assert.equal(takePlanCommand(entries, "  systemctl restart nginx\t")?.command, "systemctl restart nginx", "surrounding whitespace is ignored");
  assert.equal(entries[0]!.ran, true);
});

test("each plan entry runs once; a command listed twice runs twice", () => {
  const entries = plan("apt-get update", "apt-get install -y nginx", "apt-get update");
  assert.equal(takePlanCommand(entries, "apt-get update"), entries[0]);
  assert.equal(takePlanCommand(entries, "apt-get update"), entries[2], "the second listing");
  assert.equal(takePlanCommand(entries, "apt-get update"), undefined, "no third run");
  assert.equal(takePlanCommand(entries, "apt-get install -y nginx"), entries[1]);
  assert.equal(takePlanCommand(entries, "apt-get install -y nginx"), undefined);
  entries[1]!.ran = false; // What the gate's undo does when nothing reached the shell.
  assert.equal(takePlanCommand(entries, "apt-get install -y nginx"), entries[1]);
});

test("plans and approval-path commands must be one visible line", () => {
  assert.deepEqual(parsePlan({ goal: " Install nginx ", commands: [" apt-get update", "apt-get install -y nginx ", "echo สวัสดี > /tmp/x"] }),
    { goal: "Install nginx", commands: ["apt-get update", "apt-get install -y nginx", "echo สวัสดี > /tmp/x"] });
  for (const bad of [
    undefined, null, [], { goal: "g" }, { commands: ["ls"] }, { goal: "g", commands: [] }, { goal: "", commands: ["ls"] }, { goal: "g", commands: "ls" },
    { goal: "g", commands: ["ls"], extra: 1 }, { goal: "g", commands: [1] }, { goal: "x".repeat(1_001), commands: ["ls"] },
    { goal: "g", commands: Array.from({ length: 33 }, () => "ls") }, { goal: "g", commands: ["x".repeat(4_097)] }, { goal: "a\u0007", commands: ["ls"] },
    { goal: "g", commands: ["ls\nrm -rf /"] }, { goal: "g", commands: ["ls\r"] }, { goal: "g", commands: ["   "] }, { goal: "g", commands: ["rm‮ -rf"] },
    { goal: "g", commands: ["rm​ -rf"] }, { goal: "g", commands: ["rm -rf"] }, { goal: "g", commands: ["rm x"] }, { goal: "g", commands: ["a\ud800"] },
    { goal: "g", commands: ["a"] }, { goal: "g", commands: ["ls\tx"] }, { goal: "g", commands: ["a\u0085"] },
    // L1: default-ignorable characters (Hangul filler, combining grapheme joiner, variation selector) and stacked marks.
    { goal: "g", commands: ["rm\u3164-rf"] }, { goal: "g", commands: ["rm\u034f -rf"] }, { goal: "g", commands: ["rm\ufe0f -rf"] },
    { goal: "g", commands: ["rm\u115f -rf"] }, { goal: "g", commands: ["echo a\u0301\u0301\u0301"] }, { goal: "g", commands: ["echo \u0e01\u0e34\u0e48\u0e48"] },
  ]) assert.equal(typeof parsePlan(bad), "string", JSON.stringify(bad));
  assert.equal(unshowable("touch /tmp/x"), undefined);
  assert.equal(unshowable("echo \u0e17\u0e35\u0e48\u0e19\u0e35\u0e48 caf\u0065\u0301"), undefined, "Thai vowel plus tone mark (two marks) stays allowed");
  assert.equal(unshowable(" touch /tmp/x\t"), undefined);
  assert.match(unshowable("touch /tmp/x⁦")!, /invisible/u);
  assert.match(unshowable("")!, /empty/u);
});

test("mode and decision requests are validated exactly", () => {
  const owner = { windowId: 1, generation: 1 };
  const mode = { owner, sessionId: "s1", generation: 1, mode: "full-allow", acknowledged: true };
  assert.ok(isSetAgentModeRequest(mode));
  for (const bad of [{ ...mode, mode: "yolo" }, { ...mode, acknowledged: "yes" }, { ...mode, generation: 0 }, { ...mode, extra: 1 }, { owner, sessionId: "s1", generation: 1, mode: "auto" }])
    assert.equal(isSetAgentModeRequest(bad), false, JSON.stringify(bad));
  const decision = { owner, sessionId: "s1", generation: 1, approvalId: "plan-0a1b2c3d-3", decision: "approve", production: false };
  assert.ok(isDecideAgentRequest(decision));
  assert.ok(isDecideAgentRequest({ ...decision, approvalId: "command-0a1b2c3d-12", decision: "reject" }));
  for (const bad of [{ ...decision, approvalId: "plan-0a1b2c3d-0" }, { ...decision, approvalId: "plan-3" }, { ...decision, approvalId: "plan-0A1B2C3D-3" },
    { ...decision, approvalId: "task-0a1b2c3d-1" }, { ...decision, approvalId: "plan-0a1b2c3d-1 " }, { ...decision, decision: "always" },
    { ...decision, production: 1 }, { ...decision, generation: 1.5 }, { ...decision, sessionId: "../x" }])
    assert.equal(isDecideAgentRequest(bad), false, JSON.stringify(bad));
});
