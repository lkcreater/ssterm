import type { Owner, TransferErrorCode, TransferJob, TransferState } from "@ssterm/contracts";

/** A late snapshot, old window or reordered event must never rewind the visible queue. */
export function acceptTransferState(previous: TransferState | undefined, next: TransferState, owner: Owner): boolean {
  return next.owner.windowId === owner.windowId && next.owner.generation === owner.generation &&
    (!previous || next.sequence > previous.sequence);
}

/** Confirmed bytes alone never prove close/completion, even for an empty file. */
export function transferPercent(job: Pick<TransferJob, "state" | "bytes" | "total">): number | null {
  if (job.state === "completed") return 100;
  if (job.total === null || job.total === 0) return null;
  return Math.min(99, Math.floor(job.bytes / job.total * 100));
}

export const transferFinished = (job: Pick<TransferJob, "state">) =>
  job.state === "completed" || job.state === "cancelled" || job.state === "failed";

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
};
