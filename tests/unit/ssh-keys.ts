import ssh2 from "ssh2";

/**
 * ssh2 1.17's keygen strips every leading zero byte from the raw Ed25519 public key, so about 1 in 256
 * generated files carries a 31-byte key that ssh2 and ssh-keygen both reject. Real keys are unaffected.
 */
export function ed25519(options?: { passphrase: Buffer; cipher: string; rounds: number }) {
  for (;;) {
    const pair = options ? ssh2.utils.generateKeyPairSync("ed25519", options) : ssh2.utils.generateKeyPairSync("ed25519");
    if (!(ssh2.utils.parseKey(pair.private, options?.passphrase) instanceof Error)) return pair;
  }
}
