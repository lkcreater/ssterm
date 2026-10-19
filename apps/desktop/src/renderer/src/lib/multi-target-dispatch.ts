import type { TerminalSession } from "@ssterm/contracts";
import type { TerminalInputs } from "../components/workspace/terminal-inputs";
import { planDispatch, type ConfirmReason, type DispatchMode } from "./snippet-dispatch";

export const MAX_DISPATCH_TARGETS = 8;
export interface CapturedTarget {
  readonly sessionId: string;
  readonly generation: number;
  readonly label: string;
  readonly endpoint: string;
  readonly production: boolean;
}
export function captureTarget(session: TerminalSession): CapturedTarget | null {
  if (session.phase !== "ready" || session.local || !session.hostId || !session.target) return null;
  const target = session.target;
  return Object.freeze({
    sessionId: session.sessionId, generation: session.generation, label: target.label,
    endpoint: `${target.username ? `${target.username}@` : ""}${target.endpointHost}:${target.endpointPort}`,
    production: target.environment === "PROD",
  });
}
export function captureTargets(sessions: readonly TerminalSession[]): readonly CapturedTarget[] {
  return snapshotTargets(sessions.map((session) => {
    const target = captureTarget(session);
    if (!target) throw new Error("Dispatch target is not ready");
    return target;
  }));
}
function snapshotTargets(targets: readonly CapturedTarget[]): readonly CapturedTarget[] {
  if (targets.length > MAX_DISPATCH_TARGETS) throw new RangeError("Too many dispatch targets");
  const seen = new Set<string>();
  const snapshot = targets.map((target) => {
    if (seen.has(target.sessionId)) throw new Error("Duplicate dispatch target");
    seen.add(target.sessionId);
    return Object.freeze({ ...target });
  });
  return Object.freeze(snapshot);
}
interface TargetOptions {
  targets: readonly CapturedTarget[];
  text: string;
  mode: DispatchMode;
  inputs: TerminalInputs;
  readSession(sessionId: string): TerminalSession | undefined;
}
export interface TargetInspection {
  target: CapturedTarget;
  status: "ready" | "empty" | "too-large" | "refused";
  reasons: ConfirmReason[];
}
export interface TargetDispatchResult {
  target: CapturedTarget;
  status: "accepted" | "refused" | "cancelled" | "empty" | "too-large" | "needs-confirmation";
  reasons: ConfirmReason[];
}
function prepare(options: TargetOptions, target: CapturedTarget) {
  const session = options.readSession(target.sessionId);
  const input = options.inputs.get(target.sessionId);
  if (!session || session.local || !session.hostId || !session.target || session.phase !== "ready" || session.generation !== target.generation ||
      !input || input.generation !== target.generation || !input.accepting()) return null;
  return { input, plan: planDispatch({
    text: options.text, mode: options.mode, bracketed: input.bracketed(),
    production: target.production || session.target.environment === "PROD",
  }) };
}
/** Preflight contains only summaries; encoded command bytes never escape this helper. */
export function inspectTargets(options: TargetOptions): TargetInspection[] {
  return snapshotTargets(options.targets).map((target) => {
    const prepared = prepare(options, target);
    if (!prepared) return { target, status: "refused", reasons: [] };
    const { plan } = prepared;
    if (plan.kind === "empty") return { target, status: "empty", reasons: [] };
    if (plan.kind === "refuse") return { target, status: "too-large", reasons: [] };
    const reasons = [...plan.reasons];
    plan.bytes.fill(0);
    return { target, status: "ready", reasons };
  });
}
/**
 * Sequential, generation-fenced writes. Cancellation cannot retract a handed-off write: await
 * its real answer, then cancel the remaining targets. "accepted" describes bytes, not execution.
 */
export async function dispatchTargets(options: TargetOptions & {
  signal?: AbortSignal;
  approvedReasons?: ReadonlyMap<string, readonly ConfirmReason[]>;
  onResult?(result: TargetDispatchResult): void;
}): Promise<TargetDispatchResult[]> {
  const results: TargetDispatchResult[] = [];
  for (const target of snapshotTargets(options.targets)) {
    let result: TargetDispatchResult;
    if (options.signal?.aborted) result = { target, status: "cancelled", reasons: [] };
    else {
      const prepared = prepare(options, target);
      if (!prepared) result = { target, status: "refused", reasons: [] };
      else {
        const { input, plan } = prepared;
        if (plan.kind === "empty") result = { target, status: "empty", reasons: [] };
        else if (plan.kind === "refuse") result = { target, status: "too-large", reasons: [] };
        else {
          const reasons = [...plan.reasons];
          try {
            const approved = options.approvedReasons?.get(target.sessionId) ?? [];
            if (reasons.some((reason) => !approved.includes(reason)))
              result = { target, status: "needs-confirmation", reasons };
            else if (options.signal?.aborted) result = { target, status: "cancelled", reasons: [] };
            else {
              // The pane copies synchronously into its owned queue; do not retain our planning copy
              // while main's acknowledgement is pending (including after cancellation or lock).
              const delivery = input.deliver(plan.bytes, target.generation);
              plan.bytes.fill(0);
              const outcome = await delivery;
              result = { target, status: outcome === "sent" ? "accepted" : "refused", reasons };
            }
          } catch {
            result = { target, status: "refused", reasons };
          } finally { plan.bytes.fill(0); }
        }
      }
    }
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
