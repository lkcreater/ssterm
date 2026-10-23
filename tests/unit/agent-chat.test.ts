import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage, AgentTask } from "../../packages/contracts/src/index.ts";
import { chatItems } from "../../apps/desktop/src/renderer/src/lib/agent-chat.ts";

const message = (id: number, role: AgentMessage["role"]): AgentMessage => ({ id, role, text: `m${id}` });
const task = (n: number, afterMessage: number): AgentTask => ({
  id: `task-${n}`, goal: "g", status: "completed", subAgentReport: null, limitReached: false, steps: [], plan: null, approval: null, afterMessage,
});
const shape = (items: ReturnType<typeof chatItems>) => items.map((item) => item.kind === "ai"
  ? item.parts.map((part) => part.kind === "message" ? `m${part.message.id}` : part.task.id).join(",") : `${item.kind}:${item.message.id}`);

test("SST-043 chat items: tasks sit in the AI bubble of the turn that delegated them", () => {
  // Text before the tool call: the task follows that text, and the summary joins the same bubble.
  assert.deepEqual(shape(chatItems([message(1, "user"), message(2, "assistant"), message(3, "assistant")], [task(1, 2)])),
    ["user:1", "m2,task-1,m3"]);
  // No text before the tool call: the task opens the turn's bubble; a notice ends it; the next turn has its own.
  assert.deepEqual(shape(chatItems([message(1, "user"), message(2, "assistant"), message(3, "notice"), message(4, "user"), message(5, "assistant")],
    [task(1, 1), task(2, 4), task(3, 4)])), ["user:1", "task-1,m2", "notice:3", "user:4", "task-2,task-3,m5"]);
  // The delegating message was trimmed: the task comes first, in its own bubble.
  assert.deepEqual(shape(chatItems([message(9, "user")], [task(1, 3)])), ["task-1", "user:9"]);
  assert.deepEqual(chatItems([], []), []);
});

test("SST-043 review H1: deeply nested or oversized agent text is shown as plain text", async () => {
  const { plainOnly, MARKDOWN_LIMITS } = await import("../../apps/desktop/src/renderer/src/lib/agent-chat.ts");
  assert.equal(plainOnly(`x\n${">".repeat(4_000)}`), true);
  assert.equal(plainOnly(`x\r${">".repeat(4_000)}`), true, "bare CR line ending");
  assert.equal(plainOnly(`x\r${"- ".repeat(3_000)}`), true, "bare CR before nested list markers");
  assert.equal(plainOnly("*".repeat(5_000)), true);
  assert.equal(plainOnly("a_".repeat(MARKDOWN_LIMITS.delimiters + 1)), true, "many delimiters");
  assert.equal(plainOnly("- ".repeat(MARKDOWN_LIMITS.depth + 1) + "x"), true, "nested list markers");
  assert.equal(plainOnly(`${" ".repeat(MARKDOWN_LIMITS.indent + 1)}x`), true, "deep indentation");
  assert.equal(plainOnly("x".repeat(MARKDOWN_LIMITS.size + 1)), true, "size");
  // Ordinary agent text stays Markdown.
  assert.equal(plainOnly("Disk report with **bold** and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> > twice\n\n- one\n  - two\n---"), false);
});
