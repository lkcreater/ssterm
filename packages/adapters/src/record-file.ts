import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A small non-secret record in the profile (e.g. the app-lock marker), replaced atomically with mode 0600. */
export class FileRecordStore {
  constructor(private readonly path: string) {}
  async read(): Promise<{ status: "present"; value: Uint8Array } | { status: "missing" } | { status: "error" }> {
    try {
      const value = await readFile(this.path);
      return value.length > 65_536 ? { status: "error" } : { status: "present", value };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "error" };
    }
  }
  async write(value: Uint8Array): Promise<"confirmed" | "unknown" | "invalid"> {
    if (!(value instanceof Uint8Array)) return "invalid";
    const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      return "confirmed";
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return "unknown";
    }
  }
}
