import type { AgentMessage, AgentTask } from "@ssterm/contracts";

export type ChatPart = { kind: "message"; message: AgentMessage } | { kind: "task"; task: AgentTask };
export type ChatItem = { kind: "user" | "notice"; message: AgentMessage } | { kind: "ai"; key: string; parts: ChatPart[] };

/**
 * SST-043: the conversation as the panel shows it. Consecutive assistant messages form one AI bubble; a task goes into
 * the bubble of the turn that delegated it, right after the message it followed (`afterMessage`). A task that followed a
 * user message or notice opens that turn's bubble. Tasks whose message was trimmed come first.
 */
export function chatItems(messages: readonly AgentMessage[], tasks: readonly AgentTask[]): ChatItem[] {
  const items: ChatItem[] = [];
  let ai: Extract<ChatItem, { kind: "ai" }> | undefined;
  const bubble = (key: string) => {
    if (!ai) items.push(ai = { kind: "ai", key, parts: [] });
    return ai;
  };
  const ids = new Set(messages.map((message) => message.id));
  for (const task of tasks) if (!ids.has(task.afterMessage)) bubble(`tasks-${task.id}`).parts.push({ kind: "task", task });
  for (const message of messages) {
    if (message.role === "assistant") bubble(`ai-${message.id}`).parts.push({ kind: "message", message });
    else { ai = undefined; items.push({ kind: message.role, message }); }
    for (const task of tasks) if (task.afterMessage === message.id) bubble(`ai-${message.id}`).parts.push({ kind: "task", task });
  }
  return items;
}

/** SST-043 review H1: beyond these, agent text is shown as plain text (deep nesting overflows the Markdown renderer's stack). */
export const MARKDOWN_LIMITS = Object.freeze({ size: 20_000, depth: 12, indent: 48, run: 48, delimiters: 1_000 });
const CONTAINER = /^[ \t]*(?:>|[*+-][ \t]|\d{1,9}[.)][ \t])/u;
/** True when the text is too large or too deeply nested to render as Markdown safely. */
export function plainOnly(text: string): boolean {
  const limits = MARKDOWN_LIMITS;
  if (text.length > limits.size) return true;
  if ((text.match(/[*_~[\]]/gu)?.length ?? 0) > limits.delimiters) return true;
  if (new RegExp(`[*_~[\\]]{${limits.run},}`, "u").test(text)) return true;
  // CommonMark line endings include a bare CR, so split on CRLF, CR and LF alike.
  for (const line of text.split(/\r\n?|\n/u)) {
    if ((/^[ \t]*/u.exec(line)?.[0].length ?? 0) > limits.indent) return true;
    let rest = line;
    for (let depth = 0; ; depth++) {
      const marker = CONTAINER.exec(rest);
      if (!marker) break;
      if (depth >= limits.depth) return true;
      rest = rest.slice(marker[0].length);
    }
  }
  return false;
}
