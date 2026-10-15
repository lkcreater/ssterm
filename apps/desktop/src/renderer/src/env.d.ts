/// <reference types="vite/client" />
import type { DesktopAPI } from "@ssterm/contracts";

declare global {
  interface Window {
    readonly ssterm?: DesktopAPI;
  }
}
