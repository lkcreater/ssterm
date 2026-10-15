import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import {
  HOST_KEY_ALGORITHMS,
  type HostKeyAlgorithm,
  type HostKeyIdentity,
} from "@ssterm/domain";

export const MAX_HOST_KEY_BYTES = 16_384;
const algorithms: readonly string[] = HOST_KEY_ALGORITHMS;
const storedKey = new RegExp(
  `^(${HOST_KEY_ALGORITHMS.join("|")}) ([A-Za-z0-9+/]+={0,2})$`,
  "u",
);

/** Main-only mature parser; exact wire roundtrip rejects printable/private/trailing material. */
export function decodeHostPublicKey(
  wire: Uint8Array,
): HostKeyIdentity | undefined {
  if (
    !(wire instanceof Uint8Array) ||
    wire.length === 0 ||
    wire.length > MAX_HOST_KEY_BYTES
  )
    return;
  try {
    const bytes = Buffer.from(wire);
    const parsed = ssh2.utils.parseKey(bytes);
    if (
      parsed instanceof Error ||
      Array.isArray(parsed) ||
      parsed.isPrivateKey() ||
      !algorithms.includes(parsed.type)
    )
      return;
    const canonical = parsed.getPublicSSH();
    if (!Buffer.isBuffer(canonical) || !canonical.equals(bytes)) return;
    return {
      algorithm: parsed.type as HostKeyAlgorithm,
      publicKey: `${parsed.type} ${canonical.toString("base64")}`,
      fingerprint: `SHA256:${createHash("sha256").update(canonical).digest("base64").replace(/=+$/u, "")}`,
    };
  } catch {
    return;
  }
}

/** Persisted rows must describe exactly the same canonical public key and derived identity. */
export function validHostKeyIdentity(value: {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
}): boolean {
  if (
    typeof value.publicKey !== "string" ||
    value.publicKey.length > MAX_HOST_KEY_BYTES * 2
  )
    return false;
  const match = storedKey.exec(value.publicKey);
  if (!match) return false;
  const identity = decodeHostPublicKey(Buffer.from(match[2]!, "base64"));
  return (
    !!identity &&
    identity.algorithm === value.algorithm &&
    identity.publicKey === value.publicKey &&
    identity.fingerprint === value.fingerprint
  );
}
