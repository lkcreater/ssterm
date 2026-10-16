/** Editor drafts, the trivial field rules main also enforces, and the draft → intent diff. Pure and unit-tested. */
import {
  MAX_CATALOG_ADDRESS,
  validateCatalogLabel,
  validateIdentityUsername,
  validatePort,
  type CatalogAuth,
  type CatalogChangeIntent,
  type CatalogFieldError,
  type CatalogGroup,
  type CatalogHost,
  type CatalogPort,
} from "@ssterm/contracts";

export type Environment = "DEV" | "STAGING" | "PROD";
/** `inherit`, `clear` (No identity) or an identity id. */
export type AuthChoice = string;
interface CommonDraft {
  label: string;
  portMode: "inherit" | "value";
  port: string;
  auth: AuthChoice;
}
export interface HostDraft extends CommonDraft {
  address: string;
  groupId: string | null;
  environment: Environment | null;
}
export interface GroupDraft extends CommonDraft {
  parentId: string | null;
}
export type Field = CatalogFieldError["field"];
export type FieldErrors = Partial<Record<Field, string>>;
type Port = CatalogPort;
type Auth = CatalogAuth;

const messages: Record<Exclude<CatalogFieldError["code"], "required"> | "too-long-address", string> = {
  empty: "Enter a name.",
  "too-long": "Use 200 characters or fewer.",
  control: "Remove control characters.",
  duplicate: "That name is already used.",
  invalid: "",
  "too-long-address": "Use 1,024 characters or fewer.",
  cycle: "A group cannot move inside itself or its subgroups.",
  "not-found": "",
};
const fieldMessages: Record<Field, string> = {
  label: "Check this name.",
  address: "Use a host name or IP address only, without spaces, user names or paths.",
  port: "Enter a port from 1 to 65535.",
  parent: "That group no longer exists. Choose another.",
  group: "That group no longer exists. Choose another.",
  identity: "That identity no longer exists. Choose another.",
  tag: "That tag no longer exists.",
  username: "Check this user name.",
  keyId: "That key no longer exists. Choose another.",
};
const usernameMessages = {
  empty: "Enter a user name.",
  "too-long": "Use 256 characters or fewer.",
  control: "Remove control characters.",
};
const message = ({ field, code }: CatalogFieldError): string =>
  field === "username"
    ? usernameMessages[code]
    : code === "required"
      ? "Choose a key, or import one."
      : (field === "address" && code === "too-long"
          ? messages["too-long-address"]
          : messages[code]) || fieldMessages[field];

export function labelError(value: string): string | undefined {
  const code = validateCatalogLabel(value);
  return code ? message({ field: "label", code }) : undefined;
}
export function usernameError(value: string): string | undefined {
  const code = validateIdentityUsername(value.trim());
  return code ? message({ field: "username", code }) : undefined;
}
// Main still normalizes (IDNA, IP forms) and reports anything this cannot see.
export function addressError(value: string): string | undefined {
  const address = value.trim();
  if (!address) return "Enter a host name or IP address.";
  if (address.length > MAX_CATALOG_ADDRESS)
    return message({ field: "address", code: "too-long" });
  if (/[\u0000-\u001f\u007f\s/@?#%\\]/u.test(address))
    return message({ field: "address", code: "invalid" });
}
export function portError(value: string): string | undefined {
  if (!/^\d{1,5}$/u.test(value.trim()) || !validatePort(Number(value)))
    return message({ field: "port", code: "invalid" });
}

const portOf = (draft: CommonDraft): Port =>
  draft.portMode === "value"
    ? { mode: "value", port: Number(draft.port.trim()) }
    : { mode: "inherit" };
const authOf = (choice: AuthChoice): Auth =>
  choice === "inherit" || choice === "clear"
    ? { mode: choice }
    : { mode: "value", identityId: choice };
const authChoice = (auth: Auth): AuthChoice =>
  auth.mode === "value" ? auth.identityId : auth.mode;

export function hostDraft(
  host?: CatalogHost,
  groupId: string | null = null,
): HostDraft {
  return {
    label: host?.label ?? "",
    address: host?.address ?? "",
    groupId: host ? host.groupId : groupId,
    environment: host?.environment ?? null,
    portMode: host?.port.mode ?? "inherit",
    port: host?.port.mode === "value" ? String(host.port.port) : "",
    auth: host ? authChoice(host.auth) : "inherit",
  };
}
export function groupDraft(
  group?: CatalogGroup,
  parentId: string | null = null,
): GroupDraft {
  return {
    label: group?.label ?? "",
    parentId: group ? group.parentId : parentId,
    portMode: group?.port.mode ?? "inherit",
    port: group?.port.mode === "value" ? String(group.port.port) : "",
    auth: group ? authChoice(group.auth) : "inherit",
  };
}

export function hostErrors(draft: HostDraft): FieldErrors {
  return clean({
    label: labelError(draft.label),
    address: addressError(draft.address),
    port: draft.portMode === "value" ? portError(draft.port) : undefined,
  });
}
export function groupErrors(draft: GroupDraft): FieldErrors {
  return clean({
    label: labelError(draft.label),
    port: draft.portMode === "value" ? portError(draft.port) : undefined,
  });
}
const clean = (errors: FieldErrors): FieldErrors =>
  Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as FieldErrors;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Only changed fields; `undefined` when an edit changes nothing. Call after validation passes. */
export function hostIntent(
  draft: HostDraft,
  base?: CatalogHost,
): CatalogChangeIntent | undefined {
  const data = {
    label: draft.label.trim(),
    address: draft.address.trim(),
    groupId: draft.groupId,
    environment: draft.environment,
    port: portOf(draft),
    auth: authOf(draft.auth),
  };
  if (!base) return { type: "create-host", data };
  const changed = Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) => !same(value, base[key as keyof typeof data]),
    ),
  );
  return Object.keys(changed).length
    ? {
        type: "update-host",
        id: base.id,
        expectedRevision: base.revision,
        data: changed,
      }
    : undefined;
}
export function groupIntent(
  draft: GroupDraft,
  base?: CatalogGroup,
): CatalogChangeIntent | undefined {
  const data = {
    label: draft.label.trim(),
    parentId: draft.parentId,
    port: portOf(draft),
    auth: authOf(draft.auth),
  };
  if (!base) return { type: "create-group", data };
  const changed = Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) => !same(value, base[key as keyof typeof data]),
    ),
  );
  return Object.keys(changed).length
    ? {
        type: "update-group",
        id: base.id,
        expectedRevision: base.revision,
        data: changed,
      }
    : undefined;
}
export const draftsEqual = (a: object, b: object): boolean => same(a, b);
/** After a conflict: keep the fields the user edited (draft ≠ from) and take everything else from the latest entity. */
export function rebaseDraft<T extends object>(draft: T, from: T, to: T): T {
  const edited = draft as Record<string, unknown>;
  const original = from as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(to).map(([key, value]) => [
      key,
      same(edited[key], original[key]) ? value : edited[key],
    ]),
  ) as T;
}

/** Main reports `{field, code}`; the renderer owns the wording. The first error per field wins. */
export function serverFieldErrors(
  fields: readonly CatalogFieldError[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const error of fields) errors[error.field] ??= message(error);
  return errors;
}
