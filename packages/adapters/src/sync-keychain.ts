/** Opaque-ref versioned sync accounts, independent from local vault secrets/app lock. */
import { AsyncEntry } from "@napi-rs/keyring";
import {
  classifyProviderError,
  PRODUCTION_SECRET_NAMESPACE,
} from "./keychain.ts";
export interface SyncKeyRead {
  status: "present" | "missing" | "unavailable";
  value?: Uint8Array;
}
export interface SyncKeyStore {
  read(account: string): Promise<SyncKeyRead>;
  write(account: string, value: Uint8Array): Promise<"confirmed" | "unknown">;
  delete(account: string): Promise<"confirmed" | "unknown">;
}
const testNamespace = /^dev\.ssterm\.test\.[0-9a-f-]{36}$/;
function validAccount(account: string): boolean {
  return /^sync\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(owner-signing|device-signing|device-wrapping|epoch|transport-token|checkpoint)\/[0-9a-f-]{36}$/.test(
    account,
  );
}
export class KeychainSyncKeyStore implements SyncKeyStore {
  constructor(private readonly namespace: string) {
    if (
      namespace !== PRODUCTION_SECRET_NAMESPACE &&
      !testNamespace.test(namespace)
    )
      throw new Error("Unsupported secret namespace.");
  }
  async read(account: string): Promise<SyncKeyRead> {
    if (!validAccount(account)) return { status: "unavailable" };
    try {
      const raw = await new AsyncEntry(this.namespace, account).getSecret();
      if (!raw) return { status: "missing" };
      const value = Buffer.from(raw);
      raw.fill(0);
      return { status: "present", value };
    } catch (e) {
      return {
        status:
          classifyProviderError(e) === "missing" ? "missing" : "unavailable",
      };
    }
  }
  async write(
    account: string,
    value: Uint8Array,
  ): Promise<"confirmed" | "unknown"> {
    if (
      !validAccount(account) ||
      !(value instanceof Uint8Array) ||
      value.length > 8192
    )
      return "unknown";
    try {
      await new AsyncEntry(this.namespace, account).setSecret(value);
      return "confirmed";
    } catch {
      return "unknown";
    }
  }
  async delete(account: string): Promise<"confirmed" | "unknown"> {
    if (!validAccount(account)) return "unknown";
    try {
      await new AsyncEntry(this.namespace, account).deleteCredential();
      return "confirmed";
    } catch (e) {
      return classifyProviderError(e) === "missing" ? "confirmed" : "unknown";
    }
  }
}
