// Main-only entry for runtime checks of the shipped secret code; never exposed via IPC or preload.
export { KeychainSecretProvider, clearTestNamespace } from "@ssterm/adapters/keychain";
export { SecretService, TransientSecrets } from "@ssterm/services";
