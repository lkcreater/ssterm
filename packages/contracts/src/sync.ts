import { z } from "zod";
import { isOwner, type Owner } from "./index.ts";
const id = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const scope = z
  .object({ deploymentId: id, accountId: id, vaultId: id })
  .strict();
const role = z.enum(["owner", "writer", "reader"]);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(65536);
const connection = {
  endpoint: z.string().min(1).max(2048),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expectedScope: scope,
};
const resolution = z
  .object({
    key: z.string().min(1).max(100),
    choice: z.enum(["local", "remote", "restore"]),
  })
  .strict();
export const syncStateSchema = z
  .object({
    status: z.enum([
      "disabled",
      "pending",
      "enrolled",
      "locked",
      "key-unavailable",
      "reconcile",
      "revoked",
    ]),
    endpoint: z.string().max(2048).nullable(),
    scope: scope.nullable(),
    deviceId: id.nullable(),
    role: role.nullable(),
    generation: counter,
    epoch: counter,
    ownerFingerprint: hash.nullable(),
    canCancelSetup: z.boolean(),
    needsToken: z.boolean(),
    recoveryReady: z.boolean(),
    outbox: counter,
    inbox: counter,
    conflicts: counter,
    devices: z
      .array(z.object({ deviceId: id, role, fingerprint: hash }).strict())
      .max(256),
    warnings: z.array(z.string().max(2048)).max(256),
  })
  .strict();
export type SyncView = z.infer<typeof syncStateSchema>;
export const syncActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create"),
      ...connection,
      deviceLabel: z.string().min(1).max(128),
      consent: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("begin-join"),
      ...connection,
      expectedOwnerFingerprint: hash,
      role: z.enum(["writer", "reader"]),
      consent: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal("challenge"), candidateText: text }).strict(),
  z.object({ type: z.literal("prove"), challengeText: text }).strict(),
  z
    .object({
      type: z.literal("approve"),
      proofText: text,
      confirmedFingerprint: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("resume"),
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z.object({ type: z.literal("cancel-setup") }).strict(),
  z.object({ type: z.literal("finish-join") }).strict(),
  z.object({ type: z.literal("fetch") }).strict(),
  z.object({ type: z.literal("publish") }).strict(),
  z
    .object({
      type: z.literal("review"),
      operationHashes: z.array(hash).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("apply"),
      reviewToken: z.string().min(1).max(128),
      resolutions: z.array(resolution).max(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("rotate"),
      removeDeviceIds: z.array(id).max(255),
      readerDeviceIds: z.array(id).max(255),
    })
    .strict(),
  z.object({ type: z.literal("create-recovery") }).strict(),
  z
    .object({
      type: z.literal("confirm-recovery"),
      confirmationToken: z.string().min(1).max(128),
      secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("recover"),
      ...connection,
      expectedOwnerFingerprint: hash,
      secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      consent: z.literal(true),
    })
    .strict(),
  z
    .object({ type: z.literal("logout"), forgetTransportToken: z.boolean() })
    .strict(),
]);
export type SyncAction = z.infer<typeof syncActionSchema>;
export interface SyncStateRequest {
  owner: Owner;
}
export interface SyncCommandRequest {
  owner: Owner;
  action: SyncAction;
}
const reviewSchema = z
  .object({
    reviewToken: z.string().min(1).max(128),
    expiresAt: counter,
    records: counter,
    deletions: counter,
    conflicts: z
      .array(
        z
          .object({
            key: z.string().max(100),
            type: z.string().max(40),
            id,
            label: z.string().max(2048),
            reason: z.string().max(2048),
            localPreview: z.string().max(2048),
            remotePreview: z.string().max(2048),
          })
          .strict(),
      )
      .max(512),
    warnings: z.array(z.string().max(2048)).max(256),
  })
  .strict();
export type SyncReviewView = z.infer<typeof reviewSchema>;
const detail = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({ kind: z.literal("text"), text, fingerprint: hash.nullable() })
    .strict(),
  z.object({ kind: z.literal("review"), review: reviewSchema }).strict(),
  z
    .object({
      kind: z.literal("recovery"),
      confirmationToken: z.string().max(128),
      secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      saved: z.boolean(),
    })
    .strict(),
]);
export const syncReplySchema = z
  .object({
    state: syncStateSchema,
    outcome: z.enum(["ok", "failed", "cancelled"]),
    code: z
      .string()
      .regex(/^[a-z-]{1,64}$/)
      .nullable(),
    detail,
  })
  .strict();
export type SyncReply = z.infer<typeof syncReplySchema>;
export const isSyncView = (v: unknown): v is SyncView =>
  syncStateSchema.safeParse(v).success;
export const isSyncReply = (v: unknown): v is SyncReply =>
  syncReplySchema.safeParse(v).success;
export function isSyncStateRequest(v: unknown): v is SyncStateRequest {
  return (
    !!v &&
    typeof v === "object" &&
    Object.keys(v).length === 1 &&
    "owner" in v &&
    isOwner(v.owner)
  );
}
export function isSyncCommandRequest(v: unknown): v is SyncCommandRequest {
  return (
    !!v &&
    typeof v === "object" &&
    Object.keys(v).length === 2 &&
    "owner" in v &&
    isOwner(v.owner) &&
    "action" in v &&
    syncActionSchema.safeParse(v.action).success
  );
}
