import { isFileName, MAX_FILE_NAME, type Owner, type TransferErrorCode, type TransferJob, type TransferState } from "@ssterm/contracts";

/** A late snapshot, old window or reordered event must never rewind the visible queue. */
export function acceptTransferState(previous: TransferState | undefined, next: TransferState, owner: Owner): boolean {
  return next.owner.windowId === owner.windowId && next.owner.generation === owner.generation &&
    (!previous || next.sequence > previous.sequence);
}

/** Confirmed bytes alone never prove close/completion, even for an empty file. */
export function transferPercent(job: Pick<TransferJob, "state" | "bytes" | "total">): number | null {
  if (job.state === "completed") return 100;
  if (job.state === "skipped" || job.state === "conflict") return null;
  if (job.total === null || job.total === 0) return null;
  return Math.min(99, Math.floor(job.bytes / job.total * 100));
}

export const transferFinished = (job: Pick<TransferJob, "state">) =>
  job.state === "completed" || job.state === "cancelled" || job.state === "failed" || job.state === "skipped";

export const transferCanCancel = (job: Pick<TransferJob, "state">) =>
  job.state === "queued" || job.state === "running" || job.state === "conflict";

export const transferCanRetry = (job: Pick<TransferJob, "state" | "error">) =>
  (job.state === "failed" || job.state === "cancelled") && job.error !== "publication-unknown";

/** Validate without trimming or normalizing: a filename is an exact filesystem address. */
export function transferRenameProblem(name: string): string | null {
  if (!isFileName(name) || name === "." || name === ".." || name.includes("\uFFFD"))
    return "Enter a single filename, without a slash, NUL, or dot-only name.";
  if (new TextEncoder().encode(name).length > MAX_FILE_NAME) return "The filename is too long (maximum 1,024 UTF-8 bytes).";
  return null;
}

export const transferProblems: Record<TransferErrorCode, string> = {
  "not-found": "The file or destination folder no longer exists.",
  "permission-denied": "Permission was denied for the source or destination.",
  "invalid-path": "The source or destination path is invalid.",
  unsupported: "This server does not support this transfer.",
  failure: "The file could not be transferred.",
  "connection-lost": "The connection was lost.",
  "resource-limit": "The transfer reached a resource limit.",
  closed: "The SFTP session closed.",
  cancelled: "The transfer was cancelled.",
  "invalid-request": "The transfer request could not be accepted.",
  "not-file": "Only regular files can be transferred. Folders and symbolic links are not supported.",
  "destination-exists": "A file already exists at the destination. It was not overwritten.",
  timeout: "The transfer stopped responding.",
  "no-space": "The destination has no free space. Free space before retrying.",
  "quota-exceeded": "The destination quota was exceeded. Check the quota before retrying.",
  "publication-unknown": "The destination may have changed before the connection was lost. Check the destination before starting another transfer. Retry is disabled for this job.",
};
