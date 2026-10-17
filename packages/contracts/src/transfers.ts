import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";
import { isFileName, isFilePath, isFileSource, type FileSource } from "./files.ts";
import { isTerminalSession, type TerminalSession } from "./terminals.ts";

export const MAX_TRANSFER_JOBS = 100;
export const TRANSFER_ERROR_CODES = [
  "not-found", "permission-denied", "failure", "invalid-path", "unsupported", "connection-lost",
  "resource-limit", "cancelled", "closed", "invalid-request", "not-file", "destination-exists", "timeout",
] as const;
export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[number];
export type TransferStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
export interface TransferJob {
  id: string;
  sessionId: string;
  generation: number;
  direction: "upload" | "download";
  sourcePath: string;
  destinationPath: string;
  target: TerminalSession["target"];
  state: TransferStatus;
  bytes: number;
  total: number | null;
  error: TransferErrorCode | null;
  /** The newly created destination may contain incomplete data; it is retained. */
  partial: boolean;
}
export interface TransferState { owner: Owner; sequence: number; jobs: TransferJob[] }
export interface EnqueueTransfersRequest {
  owner: Owner;
  source: FileSource;
  sourceDirectory: string;
  names: string[];
  destination: FileSource;
  destinationDirectory: string;
}
export interface CancelTransferRequest { owner: Owner; jobId: string }
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
export function isEnqueueTransfersRequest(v: unknown): v is EnqueueTransfersRequest {
  return exactObject(v, ["owner", "source", "sourceDirectory", "names", "destination", "destinationDirectory"]) &&
    isOwner(v.owner) && isFileSource(v.source) && isFileSource(v.destination) && v.source.kind !== v.destination.kind &&
    isFilePath(v.sourceDirectory) && isFilePath(v.destinationDirectory) && Array.isArray(v.names) &&
    v.names.length > 0 && v.names.length <= MAX_TRANSFER_JOBS && new Set(v.names).size === v.names.length &&
    v.names.every((name) => isFileName(name) && name !== "." && name !== ".." && !name.includes("\uFFFD"));
}
export function isCancelTransferRequest(v: unknown): v is CancelTransferRequest {
  return exactObject(v, ["owner", "jobId"]) && isOwner(v.owner) && identifier(v.jobId);
}
export function isTransferJob(v: unknown): v is TransferJob {
  if (!exactObject(v, ["id", "sessionId", "generation", "direction", "sourcePath", "destinationPath", "target", "state", "bytes", "total", "error", "partial"])) return false;
  return identifier(v.id) && identifier(v.sessionId) && isCounter(v.generation) && v.generation > 0 && ["upload", "download"].includes(v.direction as string) && isFilePath(v.sourcePath) &&
    isFilePath(v.destinationPath) && isTerminalSession({ sessionId: "transfer", generation: 1, hostId: "transfer",
      phase: "ready", target: v.target, end: null, error: null }) &&
    ["queued", "running", "cancelling", "completed", "cancelled", "failed"].includes(v.state as string) &&
    isCounter(v.bytes) && (v.total === null || isCounter(v.total)) && typeof v.partial === "boolean" &&
    (v.error === null || (TRANSFER_ERROR_CODES as readonly unknown[]).includes(v.error));
}
export function isTransferState(v: unknown): v is TransferState {
  return exactObject(v, ["owner", "sequence", "jobs"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    Array.isArray(v.jobs) && v.jobs.length <= MAX_TRANSFER_JOBS && v.jobs.every(isTransferJob);
}
