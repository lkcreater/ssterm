import {
  isCommandText, isDisplayText, isRecordingPolicy, MAX_LISTED_RECORDINGS, MAX_SUGGEST_PREFIX_BYTES, MAX_SUGGESTIONS,
  type ConfigureOutcome, type DeleteRecordingTarget, type ExportOutcome, type ExportRecordingTarget, type ForgetOutcome,
  type RecordingPolicy, type RecordingState, type RecordingSummary, type SuggestOutcome, type TerminalRecording,
} from '@ssterm/domain/recording';
import { exactObject, isCounter, isOwner, type Owner } from './index.ts';
import { isTerminalTarget } from './terminals.ts';
export {
  DEFAULT_RECORDING_POLICY, RECORDING_BOUNDS, SHELL_INTEGRATION, SHELL_MATRIX, MAX_SUGGESTIONS, MAX_SUGGEST_PREFIX_BYTES,
  MAX_COMMAND_BYTES, isRecordingPolicy, isCommandText, isDisplayText, promptMark,
} from '@ssterm/domain/recording';
export type {
  RecordingPolicy, RecordingState, RecordingSummary, TerminalRecording, RecordingProblem, DeleteRecordingTarget,
  ExportRecordingTarget, SupportedShell, RecordingKeyProblem,
} from '@ssterm/domain/recording';

/** No pushed channel: the pane badge rides TerminalState, and the Recordings page pulls after each action. */
export interface RecordingStateRequest { owner: Owner }
export interface ConfigureRecordingRequest { owner: Owner; policy: RecordingPolicy }
export interface DeleteRecordingsRequest { owner: Owner; target: DeleteRecordingTarget }
/** Main shows the save dialog; no path crosses IPC. */
export interface ExportRecordingRequest { owner: Owner; target: ExportRecordingTarget }
/** The history scope is derived in main from this exact live generation, never from the renderer. */
export interface SuggestCommandsRequest { owner: Owner; sessionId: string; generation: number; prefix: string }
export interface ForgetCommandRequest { owner: Owner; sessionId: string; generation: number; text: string }
export type ConfigureRecordingResponse = ConfigureOutcome;
export type ExportRecordingResponse = ExportOutcome | { status: 'cancelled' };
export type SuggestCommandsResponse = SuggestOutcome;
export type ForgetCommandResponse = ForgetOutcome;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const sessionTarget = (v: Record<string, unknown>) => isTerminalTarget({ owner: v.owner, sessionId: v.sessionId, generation: v.generation });

export function isTerminalRecording(v: unknown): v is TerminalRecording {
  return exactObject(v, ['output', 'commands', 'state', 'gaps', 'problem']) && typeof v.output === 'boolean' && typeof v.commands === 'boolean' &&
    ['starting', 'on', 'stopped'].includes(v.state as string) && typeof v.gaps === 'boolean' &&
    (v.problem === null || ['storage-unavailable', 'key-unavailable', 'write-failed', 'size-limit'].includes(v.problem as string));
}
function isRecordingSummary(v: unknown): v is RecordingSummary {
  return exactObject(v, ['id', 'label', 'environment', 'local', 'endpoint', 'startedAt', 'bytes', 'state']) && typeof v.id === 'string' &&
    UUID.test(v.id) && text(v.label, 1024) && ['DEV', 'STAGING', 'PROD', null].includes(v.environment as string | null) &&
    typeof v.local === 'boolean' && (v.endpoint === null || text(v.endpoint, 2048)) && isCounter(v.startedAt) && isCounter(v.bytes) &&
    ['recording', 'complete', 'incomplete'].includes(v.state as string);
}
export function isRecordingState(v: unknown): v is RecordingState {
  return exactObject(v, ['policy', 'problem', 'logs', 'logCount', 'logBytes', 'historyFiles', 'historyBytes']) && isRecordingPolicy(v.policy) &&
    (v.problem === null || v.problem === 'storage-unavailable' || v.problem === 'key-unavailable') && Array.isArray(v.logs) &&
    v.logs.length <= MAX_LISTED_RECORDINGS && v.logs.every(isRecordingSummary) && isCounter(v.logCount) && isCounter(v.logBytes) &&
    isCounter(v.historyFiles) && isCounter(v.historyBytes);
}
function isDeleteTarget(v: unknown): v is DeleteRecordingTarget {
  if (exactObject(v, ['kind', 'id'])) return v.kind === 'log' && typeof v.id === 'string' && UUID.test(v.id);
  return exactObject(v, ['kind']) && ['logs', 'history', 'all'].includes(v.kind as string);
}
function isExportTarget(v: unknown): v is ExportRecordingTarget {
  if (exactObject(v, ['kind', 'id'])) return v.kind === 'log' && typeof v.id === 'string' && UUID.test(v.id);
  return exactObject(v, ['kind']) && v.kind === 'history';
}
export function isRecordingStateRequest(v: unknown): v is RecordingStateRequest { return exactObject(v, ['owner']) && isOwner(v.owner); }
export function isConfigureRecordingRequest(v: unknown): v is ConfigureRecordingRequest {
  return exactObject(v, ['owner', 'policy']) && isOwner(v.owner) && isRecordingPolicy(v.policy);
}
export function isDeleteRecordingsRequest(v: unknown): v is DeleteRecordingsRequest {
  return exactObject(v, ['owner', 'target']) && isOwner(v.owner) && isDeleteTarget(v.target);
}
export function isExportRecordingRequest(v: unknown): v is ExportRecordingRequest {
  return exactObject(v, ['owner', 'target']) && isOwner(v.owner) && isExportTarget(v.target);
}
export function isSuggestCommandsRequest(v: unknown): v is SuggestCommandsRequest {
  return exactObject(v, ['owner', 'sessionId', 'generation', 'prefix']) && sessionTarget(v) && isDisplayText(v.prefix, MAX_SUGGEST_PREFIX_BYTES);
}
export function isForgetCommandRequest(v: unknown): v is ForgetCommandRequest {
  return exactObject(v, ['owner', 'sessionId', 'generation', 'text']) && sessionTarget(v) && isCommandText(v.text);
}
export function isConfigureRecordingResponse(v: unknown): v is ConfigureRecordingResponse {
  if (exactObject(v, ['status', 'state'])) return v.status === 'saved' && isRecordingState(v.state);
  if (exactObject(v, ['status', 'reason'])) return v.status === 'key-unavailable' &&
    ['uninitialized', 'missing', 'locked', 'denied', 'unavailable', 'error', 'constraint'].includes(v.reason as string);
  return exactObject(v, ['status']) && v.status === 'failed';
}
export function isExportRecordingResponse(v: unknown): v is ExportRecordingResponse {
  if (exactObject(v, ['status', 'incomplete', 'gaps'])) return v.status === 'saved' && typeof v.incomplete === 'boolean' && isCounter(v.gaps);
  return exactObject(v, ['status']) && ['cancelled', 'not-found', 'key-unavailable', 'corrupt', 'failed', 'aborted'].includes(v.status as string);
}
/** Every suggestion is re-checked: a control or bidi character never reaches the renderer. */
export function isSuggestCommandsResponse(v: unknown): v is SuggestCommandsResponse {
  if (exactObject(v, ['status', 'suggestions'])) return v.status === 'ok' && Array.isArray(v.suggestions) &&
    v.suggestions.length <= MAX_SUGGESTIONS && v.suggestions.every(isCommandText);
  return exactObject(v, ['status']) && ['off', 'key-unavailable', 'locked'].includes(v.status as string);
}
export function isForgetCommandResponse(v: unknown): v is ForgetCommandResponse {
  return exactObject(v, ['status']) && ['forgotten', 'not-found', 'off', 'key-unavailable', 'locked', 'failed'].includes(v.status as string);
}
