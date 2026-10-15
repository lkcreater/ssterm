/** Main-only production lifecycle entry; this grants no renderer capability. */
export { SessionRegistry } from "@ssterm/services";
export { TransientSecrets } from "@ssterm/services";
export { createDesktopSessions, sessionOwnerId } from "./session-runtime";
