/** SSH key identity is independent of the negotiated signature algorithm. */
export const HOST_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
] as const;
export type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number];
export interface HostKeyIdentity {
  algorithm: HostKeyAlgorithm;
  /** Canonical OpenSSH public key, without a comment. */
  publicKey: string;
  fingerprint: string;
}
