"use strict";
// An owned real process models both in-place and atomic UTF-8 editor saves. No native editor is launched.
const fs = require("node:fs");
const { dirname, basename, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const [document, mode] = process.argv.slice(2);
if (basename(document) !== "document.txt" || !["append", "replace"].includes(mode)) process.exit(2);
const suffix = "\nบันทึกจาก editor ที่เป็น fixture 🚀\n";
if (mode === "append") fs.appendFileSync(document, suffix);
else {
  const staged = join(dirname(document), `editor-${randomUUID()}.tmp`);
  fs.writeFileSync(staged, fs.readFileSync(document, "utf8") + suffix, { flag: "wx", mode: 0o600 });
  fs.renameSync(staged, document);
}
