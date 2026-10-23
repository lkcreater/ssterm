/**
 * SST-041 ticket 07: paired external MCP clients (ADR 0009 A7, A8).
 *
 * - Pairing: Settings issues one short-lived, single-use token at a time (its SHA-256 only is kept), rate-limited per
 *   window and burned after repeated wrong presentations. The client presents it once with its name; the user approves
 *   the name in ssterm; the client then gets its credential once, over the 0600 socket.
 * - Credential: `<client id>_<256-bit secret>`. Keychain keeps only its SHA-256 verifier (`mcp-client/v1/<id>`); it is
 *   compared in constant time. The client list (name, created, last used, tool timeout) is a 0600 profile file.
 * - Revoke and turning the feature off invalidate at once (in memory first), then persist. A revoked id stays listed as
 *   `revoked` until its Keychain item is deleted (retried at launch), and a listed client without its Keychain item is
 *   dropped at launch, so neither a failed list write nor a failed delete brings a revoked client back.
 * - Names are unique (case-insensitive) among paired clients.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  EXTERNAL_TIMEOUT_DEFAULT, EXTERNAL_TIMEOUT_MAX, EXTERNAL_TIMEOUT_MIN, MAX_EXTERNAL_CLIENTS, exactObject, isCounter, isExternalClientName,
  type ExternalClientView,
} from "@ssterm/contracts";

export interface ClientRecordStore {
  read(): Promise<{ status: "present"; value: Uint8Array } | { status: "missing" } | { status: "error" }>;
  write(value: Uint8Array): Promise<"confirmed" | "unknown" | "invalid">;
}
/** The Keychain item per client (`KeychainMcpClientStore`). */
export interface ClientKeys {
  read(clientId: string): Promise<Uint8Array | "missing" | "error">;
  write(clientId: string, value: Uint8Array): Promise<boolean>;
  delete(clientId: string): Promise<boolean>;
}
export const PAIRING_MS = 5 * 60_000;
/** At most 5 tokens per 10 minutes; 5 wrong presentations burn the outstanding one. */
const PAIRINGS_PER_WINDOW = 5;
const PAIRING_WINDOW_MS = 10 * 60_000;
const MAX_PAIRING_FAILURES = 5;
const PAIRING_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export const EXTERNAL_CREDENTIAL = /^([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/u;
const sha = (value: string) => createHash("sha256").update(value).digest();
/** Never matches a real verifier: unknown ids take the same comparison path. */
const DUMMY = randomBytes(32);

interface Pairing { digest: Buffer; expiresAt: number; failures: number; reserved: boolean }
/** One presentation in progress: the user decides while the client waits. */
export interface PairingTicket { readonly pairing: object; readonly expiresAt: number }

const CLIENT_ID = /^[0-9a-f]{32}$/u;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Anything but an exact version 1 or 2 record reads as off with no clients; version 2 adds revoked ids to clean up. */
export function parseExternalClients(bytes: Uint8Array | undefined): { enabled: boolean; clients: ExternalClientView[]; revoked: string[] } {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const v2 = exactObject(value, ["version", "enabled", "clients", "revoked"]) && value.version === 2 && Array.isArray(value.revoked) &&
      value.revoked.length <= 64 && value.revoked.every((id) => typeof id === "string" && CLIENT_ID.test(id));
    if (!(v2 || (exactObject(value, ["version", "enabled", "clients"]) && value.version === 1)) || typeof (value as { enabled?: unknown }).enabled !== "boolean" ||
      !Array.isArray((value as { clients?: unknown }).clients) || (value as { clients: unknown[] }).clients.length > MAX_EXTERNAL_CLIENTS) return { enabled: false, clients: [], revoked: [] };
    const record = value as { enabled: boolean; clients: unknown[]; revoked?: string[] };
    const revoked = [...new Set(record.revoked ?? [])];
    const clients = record.clients.filter((v): v is ExternalClientView => exactObject(v, ["id", "name", "createdAt", "lastUsedAt", "timeoutSec"]) &&
      typeof v.id === "string" && CLIENT_ID.test(v.id) && !revoked.includes(v.id) && isExternalClientName(v.name) && isCounter(v.createdAt) &&
      (v.lastUsedAt === null || isCounter(v.lastUsedAt)) && Number.isSafeInteger(v.timeoutSec) &&
      (v.timeoutSec as number) >= EXTERNAL_TIMEOUT_MIN && (v.timeoutSec as number) <= EXTERNAL_TIMEOUT_MAX);
    return { enabled: record.enabled, clients: clients.map((client) => ({ ...client })), revoked };
  } catch { return { enabled: false, clients: [], revoked: [] }; }
}

export function createExternalClients(options: { store: ClientRecordStore; keys: ClientKeys | undefined; now?: () => number; pairingMs?: number }) {
  const now = options.now ?? Date.now;
  const pairingMs = options.pairingMs ?? PAIRING_MS;
  let enabled = false;
  let clients: ExternalClientView[] = [];
  /** Revoked ids whose Keychain item could not be deleted yet. */
  let revoked: string[] = [];
  const verifiers = new Map<string, Buffer>();
  let pairing: Pairing | undefined;
  const issued: number[] = [];
  const dropListeners = new Set<(clientId?: string) => void>();
  let writing: Promise<unknown> = Promise.resolve();
  /** Writes serialize, each with the state current when it runs. */
  const save = (): Promise<boolean> => {
    const next = writing.then(() => options.store.write(new TextEncoder().encode(JSON.stringify({ version: 2, enabled, clients, revoked })))).then((r) => r === "confirmed", () => false);
    writing = next;
    return next;
  };
  const drop = (clientId?: string) => { for (const listener of [...dropListeners]) try { listener(clientId); } catch { /* A listener never blocks a revoke. */ } };
  const live = () => !!pairing && pairing.expiresAt > now() ? pairing : (pairing = undefined);

  const ready = (async () => {
    const stored = await options.store.read().catch(() => ({ status: "error" as const }));
    ({ enabled, clients, revoked } = parseExternalClients(stored.status === "present" ? stored.value : undefined));
    // Without Keychain no client can authenticate (fail closed).
    if (!options.keys) return;
    const keys = options.keys;
    const before = JSON.stringify({ clients, revoked });
    // A revoke whose Keychain delete failed is retried; a client whose item is gone stays gone.
    revoked = (await Promise.all(revoked.map(async (id) => (await keys.delete(id).catch(() => false)) ? undefined : id))).filter((id): id is string => !!id);
    for (const client of clients) {
      const value = await keys.read(client.id).catch(() => "error" as const);
      if (value instanceof Uint8Array && value.length === 32) verifiers.set(client.id, Buffer.from(value));
      else if (value === "missing") clients = clients.filter((entry) => entry !== client);
    }
    if (JSON.stringify({ clients, revoked }) !== before) await save();
  })();

  return {
    ready,
    get enabled() { return enabled; },
    get available() { return !!options.keys; },
    list: (): ExternalClientView[] => clients.map((client) => ({ ...client })),
    client: (clientId: string): ExternalClientView | undefined => { const found = clients.find((client) => client.id === clientId); return found && { ...found }; },
    /** Off drops every client's connections and binding and the outstanding token; paired clients stay paired. */
    async setEnabled(on: boolean): Promise<boolean> {
      if (on && !options.keys) return false;
      const was = enabled;
      enabled = on;
      if (!on) { pairing = undefined; drop(); }
      if (await save()) return true;
      enabled = was;
      return false;
    },
    /** A new one-time token (the previous one is replaced); shown once. */
    issuePairing(): { token: string; expiresAt: number } | "disabled" | "unavailable" | "rate-limited" | "limit" {
      if (!options.keys) return "unavailable";
      if (!enabled) return "disabled";
      if (clients.length >= MAX_EXTERNAL_CLIENTS) return "limit";
      const at = now();
      while (issued.length && issued[0]! <= at - PAIRING_WINDOW_MS) issued.shift();
      if (issued.length >= PAIRINGS_PER_WINDOW) return "rate-limited";
      issued.push(at);
      const token = randomBytes(32).toString("base64url");
      pairing = { digest: sha(token), expiresAt: at + pairingMs, failures: 0, reserved: false };
      return { token, expiresAt: pairing.expiresAt };
    },
    /**
     * The client's first connect: reserves the live token for the user's decision (one at a time), else undefined.
     * `name-in-use`: the right token, but a paired client already has that name (the token stays).
     */
    present(token: string, name: string): PairingTicket | "name-in-use" | undefined {
      const current = enabled ? live() : undefined;
      if (!current || typeof token !== "string" || !PAIRING_TOKEN.test(token) || !isExternalClientName(name)) {
        if (current) current.failures += 1;
      } else if (timingSafeEqual(sha(token), current.digest) && !current.reserved) {
        if (clients.some((client) => sameName(client.name, name))) return "name-in-use";
        current.reserved = true;
        return { pairing: current, expiresAt: current.expiresAt };
      } else current.failures += 1;
      if (current && current.failures >= MAX_PAIRING_FAILURES && pairing === current) pairing = undefined;
      return undefined;
    },
    /** Not approved: a denial burns the token; a dropped connection or expiry leaves it for its remaining life. */
    release(ticket: PairingTicket, burn: boolean): void {
      const current = ticket.pairing as Pairing;
      current.reserved = false;
      if (burn && pairing === current) pairing = undefined;
    },
    /** Approved: the token is used up, the verifier goes to Keychain and the client list, the credential to the client. */
    async complete(ticket: PairingTicket, name: string): Promise<{ clientId: string; credential: string } | undefined> {
      const current = ticket.pairing as Pairing;
      if (pairing !== current || !current.reserved || !enabled || !options.keys || current.expiresAt <= now() || clients.length >= MAX_EXTERNAL_CLIENTS ||
        clients.some((client) => sameName(client.name, name))) {
        current.reserved = false;
        return undefined;
      }
      pairing = undefined;
      const clientId = randomBytes(16).toString("hex");
      const secret = randomBytes(32).toString("base64url");
      const verifier = sha(secret);
      if (!(await options.keys.write(clientId, verifier).catch(() => false))) return undefined;
      const record: ExternalClientView = { id: clientId, name, createdAt: now(), lastUsedAt: null, timeoutSec: EXTERNAL_TIMEOUT_DEFAULT };
      clients = [...clients, record];
      if (!enabled || !(await save())) {
        clients = clients.filter((client) => client !== record);
        await options.keys.delete(clientId).catch(() => false);
        return undefined;
      }
      verifiers.set(clientId, verifier);
      return { clientId, credential: `${clientId}_${secret}` };
    },
    /** A paired client's credential, compared in constant time; its id, or undefined. */
    authenticate(credential: string): string | undefined {
      const match = typeof credential === "string" ? EXTERNAL_CREDENTIAL.exec(credential) : null;
      if (!match) return undefined;
      const verifier = verifiers.get(match[1]!);
      const equal = timingSafeEqual(sha(match[2]!), verifier ?? DUMMY);
      return enabled && verifier && equal && clients.some((client) => client.id === match[1]) ? match[1] : undefined;
    },
    /** Last use, written at most once a minute per client. */
    touch(clientId: string): void {
      const client = clients.find((entry) => entry.id === clientId);
      const at = now();
      if (!client || (client.lastUsedAt !== null && at - client.lastUsedAt < 60_000)) return;
      clients = clients.map((entry) => entry === client ? { ...entry, lastUsedAt: at } : entry);
      void save();
    },
    async setTimeout(clientId: string, seconds: number): Promise<boolean> {
      if (!clients.some((client) => client.id === clientId) || !Number.isSafeInteger(seconds) || seconds < EXTERNAL_TIMEOUT_MIN || seconds > EXTERNAL_TIMEOUT_MAX) return false;
      clients = clients.map((client) => client.id === clientId ? { ...client, timeoutSec: seconds } : client);
      return save();
    },
    /**
     * Invalid at once (connections and binding dropped), then its Keychain item is deleted and the list written. Until
     * the delete succeeds the id stays in `revoked` (retried at launch); a listed client without its item is dropped.
     */
    async revoke(clientId: string): Promise<boolean> {
      if (!clients.some((client) => client.id === clientId)) return false;
      verifiers.delete(clientId);
      clients = clients.filter((client) => client.id !== clientId);
      revoked = [...revoked.filter((id) => id !== clientId), clientId];
      drop(clientId);
      const deleted = await options.keys?.delete(clientId).catch(() => false) ?? true;
      if (deleted) revoked = revoked.filter((id) => id !== clientId);
      const saved = await save();
      return saved && deleted;
    },
    /** `clientId` undefined: every client (the feature was turned off). */
    onDrop(listener: (clientId?: string) => void): () => void {
      dropListeners.add(listener);
      return () => { dropListeners.delete(listener); };
    },
  };
}
export type ExternalClients = ReturnType<typeof createExternalClients>;
