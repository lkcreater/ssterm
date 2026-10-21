import { z } from "zod";
import { isOwner, type Owner } from "./index.ts";
const id = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const role = z.enum(["Owner", "Editor", "Connector", "Viewer"]);
const memberRole = z.enum(["Editor", "Connector", "Viewer"]);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const text = z.string().max(524288);
const scope = z
  .object({
    deploymentId: id,
    accountId: id,
    teamId: id,
    metadataVaultId: id,
    credentialVaultId: id,
  })
  .strict();
const host = z
  .object({
    recordId: id,
    label: z.string().min(1).max(256),
    address: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(256),
    environment: z.enum(["DEV", "STAGING", "PROD"]).nullable(),
  })
  .strict();
const connection = {
  endpoint: z.string().min(1).max(2048),
  token,
  principalId: id,
  expectedScope: scope,
};
export const teamViewSchema = z
  .object({
    status: z.enum([
      "disabled",
      "pending",
      "enrolled",
      "revoked",
      "locked",
      "key-unavailable",
      "reconcile",
    ]),
    endpoint: z.string().max(2048).nullable(),
    scope: scope.nullable(),
    principalId: id.nullable(),
    deviceId: id.nullable(),
    role: role.nullable(),
    generation: counter,
    metadataEpoch: counter,
    credentialEpoch: counter,
    policyHash: hash.nullable(),
    metadataHash: hash.nullable(),
    credentialHash: hash.nullable(),
    ownerFingerprint: hash.nullable(),
    canManage: z.boolean(),
    recoveryReady: z.boolean(),
    needsToken: z.boolean(),
    pending: counter,
    hosts: z.array(host.extend({ virtualHostId: id })).max(128),
    members: z
      .array(
        z
          .object({
            principalId: id,
            role,
            status: z.enum(["active", "revoked"]),
            label: z.string().max(256),
          })
          .strict(),
      )
      .max(32),
    devices: z
      .array(z.object({ deviceId: id, principalId: id }).strict())
      .max(128),
    warnings: z.array(z.string().max(2048)).max(256),
  })
  .strict();
export type TeamView = z.infer<typeof teamViewSchema>;
export const teamActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create"),
      ...connection,
      displayName: z.string().min(1).max(128),
      consent: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("begin-join"),
      ...connection,
      expectedOwnerFingerprint: hash,
      consent: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("challenge"),
      candidateText: text,
      principalId: id,
      role: memberRole,
    })
    .strict(),
  z.object({ type: z.literal("prove"), challengeText: text }).strict(),
  z
    .object({
      type: z.literal("approve"),
      proofText: text,
      confirmedFingerprint: hash,
    })
    .strict(),
  z.object({ type: z.literal("finish-join") }).strict(),
  z.object({ type: z.literal("fetch") }).strict(),
  z.object({ type: z.literal("create-recovery") }).strict(),
  z.object({ type: z.literal("cancel-setup") }).strict(),
  z
    .object({
      type: z.literal("invite"),
      label: z.string().min(1).max(128),
      role: memberRole,
    })
    .strict(),
  z
    .object({
      type: z.literal("reissue-token"),
      principalId: id,
      expectedPolicyHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("save-host"),
      record: host,
      expectedMetadataHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("delete-host"),
      recordId: id,
      expectedMetadataHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("share-password"),
      recordId: id,
      password: z
        .instanceof(Uint8Array)
        .refine((v) => v.length > 0 && v.length <= 65536),
      consent: z.literal(true),
      expectedMetadataHash: hash,
      expectedCredentialHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("detach-password"),
      recordId: id,
      expectedCredentialHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("change-role"),
      principalId: id,
      role: memberRole,
      expectedPolicyHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("revoke-principal"),
      principalId: id,
      expectedPolicyHash: hash,
    })
    .strict(),
  z.object({ type: z.literal("audit"), afterSequence: counter }).strict(),
  z
    .object({
      type: z.literal("confirm-recovery"),
      confirmationToken: z.string().max(128),
      secret: token,
    })
    .strict(),
  z
    .object({
      type: z.literal("recover"),
      ...connection,
      expectedOwnerFingerprint: hash,
      secret: token,
      consent: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal("resume"), token }).strict(),
  z
    .object({ type: z.literal("logout"), forgetTransportToken: z.boolean() })
    .strict(),
]);
export type TeamAction = z.infer<typeof teamActionSchema>;
const invitation = z
  .object({
    endpoint: z.string().max(2048),
    scope,
    principalId: id,
    token,
    ownerFingerprint: hash,
  })
  .strict();
const auditEntry = z
  .object({
    sequence: counter,
    time: counter,
    principalId: id.nullable(),
    deviceId: id.nullable(),
    recordId: id.nullable(),
    policyHash: hash.nullable(),
    requestId: id.nullable(),
    action: z.enum([
      "policy-published",
      "metadata-written",
      "credential-written",
      "connect-authorized",
      "request-denied",
      "client-connect-requested",
      "client-connect-ready",
      "client-connect-ended",
    ]),
    outcome: z.enum(["accepted", "denied"]),
  })
  .strict();
export const teamReplySchema = z
  .object({
    state: teamViewSchema,
    outcome: z.enum(["ok", "failed", "cancelled"]),
    code: z
      .string()
      .regex(/^[a-z-]{1,64}$/)
      .nullable(),
    detail: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({ kind: z.literal("text"), text, fingerprint: hash.nullable() })
        .strict(),
      z.object({ kind: z.literal("invitation"), invitation }).strict(),
      z
        .object({
          kind: z.literal("recovery"),
          confirmationToken: z.string().max(128),
          secret: token,
          saved: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("audit"),
          page: z
            .object({
              entries: z.array(auditEntry).max(100),
              firstAvailableSequence: counter,
              nextSequence: counter,
              hasMore: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();
export type TeamReply = z.infer<typeof teamReplySchema>;
export interface TeamStateRequest {
  owner: Owner;
}
export interface TeamCommandRequest {
  owner: Owner;
  action: TeamAction;
}
export const isTeamView = (v: unknown): v is TeamView =>
  teamViewSchema.safeParse(v).success;
export const isTeamReply = (v: unknown): v is TeamReply =>
  teamReplySchema.safeParse(v).success;
export function isTeamStateRequest(v: unknown): v is TeamStateRequest {
  return (
    !!v &&
    typeof v === "object" &&
    Object.keys(v).length === 1 &&
    "owner" in v &&
    isOwner(v.owner)
  );
}
export function isTeamCommandRequest(v: unknown): v is TeamCommandRequest {
  return (
    !!v &&
    typeof v === "object" &&
    Object.keys(v).length === 2 &&
    "owner" in v &&
    isOwner(v.owner) &&
    "action" in v &&
    teamActionSchema.safeParse(v.action).success
  );
}
