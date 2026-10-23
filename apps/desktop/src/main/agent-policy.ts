/**
 * SST-041 ticket 04: plan matching for Auto mode (ADR 0009 A1, A2, A8).
 *
 * Matching rules:
 * - A command matches a plan command only when both are byte-for-byte equal after removing leading and trailing
 *   spaces (U+0020) and tabs (U+0009). Nothing else is normalized: no Unicode normalization, case folding, inner
 *   whitespace collapsing or quote rewriting. `ls -l`, `ls  -l`, `ls -l; rm x`, `'ls' -l` and `ls -l ` with a
 *   no-break space are all different commands.
 * - What runs is the approved plan text itself (the normalized string), never the agent's variant of it.
 * - Each plan entry runs at most once. A command listed twice may run twice; a further run asks the user. An entry is
 *   given back only when nothing reached the shell (the executor refused it, or the terminal was not at a prompt).
 * - A plan or approval-path command must be one visible line: control, format (bidi, zero-width), separator,
 *   private-use, unassigned, lone-surrogate and default-ignorable characters, any space other than U+0020, and runs of
 *   more than two combining marks are refused, so the card the user approves shows exactly what is typed.
 */
import { exactObject } from "@ssterm/contracts";
import { MAX_AGENT_COMMAND } from "@ssterm/services";

export const MAX_PLAN_COMMANDS = 32;
export const MAX_PLAN_GOAL = 1_000;
/** Per task, so a looping agent cannot flood the panel with cards. */
export const MAX_PLANS_PER_TASK = 8;
/** How long a plan or command card waits for the user before the call is answered as expired. */
export const APPROVAL_WAIT_MS = 5 * 60_000;

const HIDDEN = /(?! )[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\p{Default_Ignorable_Code_Point}]|[\p{Mn}\p{Me}]{3,}/u;
export const normalizeCommand = (command: string): string => command.replace(/^[ \t]+|[ \t]+$/gu, "");
/** Why a command cannot be shown faithfully on an approval card (or typed as one line), if it cannot. */
export function unshowable(command: string): string | undefined {
  const normalized = normalizeCommand(command);
  if (!normalized) return "an empty command";
  if (normalized.length > MAX_AGENT_COMMAND) return "a command longer than 4096 characters";
  if (HIDDEN.test(normalized)) return "control, invisible or non-standard space characters, stacked combining marks, or more than one line";
  return undefined;
}

export interface PlanEntry { command: string; ran: boolean }
export function parsePlan(args: unknown): { goal: string; commands: string[] } | string {
  const usage = `propose_plan takes \`goal\` (one line, up to ${MAX_PLAN_GOAL} characters) and \`commands\` (1–${MAX_PLAN_COMMANDS} one-line shell commands, exactly as you will run them).`;
  if (!exactObject(args, ["goal", "commands"]) || typeof args.goal !== "string" || !Array.isArray(args.commands)) return usage;
  const goal = args.goal.trim();
  if (!goal || goal.length > MAX_PLAN_GOAL || HIDDEN.test(goal.replace(/\t/gu, " "))) return usage;
  if (args.commands.length < 1 || args.commands.length > MAX_PLAN_COMMANDS || !args.commands.every((command) => typeof command === "string")) return usage;
  const commands = args.commands as string[];
  for (const [at, command] of commands.entries()) {
    const problem = unshowable(command);
    if (problem) return `Plan command ${at + 1} was refused (${problem}); nothing was proposed. ${usage}`;
  }
  return { goal, commands: commands.map(normalizeCommand) };
}

/** Takes the first unused entry equal to the command; undefined when none matches. */
export function takePlanCommand(entries: PlanEntry[], command: string): PlanEntry | undefined {
  const wanted = normalizeCommand(command);
  const entry = entries.find((candidate) => !candidate.ran && candidate.command === wanted);
  if (entry) entry.ran = true;
  return entry;
}
