# Evidence และการ reproduce

ทุกไฟล์ที่นี่เป็น evidence/metadata สำหรับเตรียมแผน ไม่ใช่ application implementation ไม่มี user credential, profile snapshot หรือ session capture

| ไฟล์ | เนื้อหา |
|---|---|
| [artifact-identity.json](artifact-identity.json) | installed target/version/digest/package metadata และ inventory counts |
| [static-observations.json](static-observations.json) | S01–S07: bounded literal matches, file hashes, UTF-8 byte ranges |
| [native-shell.json](native-shell.json) | N01–N08: wrapper identities, linkage และ selected native symbols |
| [rea-analysis-metadata.json](rea-analysis-metadata.json) | R01 identity, complete top-level limitations/integrity contradictions, coverage status/limits/counts และ exact focused arguments; semantic unknown ID arrays อยู่ใน parent |
| [rea-summary-view.json](rea-summary-view.json) | R02 complete summary-view Evidence จาก REA; summary มีรายการ omitted limitations/unknowns ตามที่ tool ระบุ |
| [rea-application-evidence.json.gz](rea-application-evidence.json.gz) | R01 complete parent Evidence compressed; เก็บ parent เต็มเพื่อไม่สูญเสีย unknowns/limits จาก summary |

**R01:** `ev_6a67d56d861c986c02de1c40c8bcc97a7caf5bbb752ed0d839dcb874741e8c87`

**R02:** `ev_272c301c09f47e1f3447ad589c4d28dd908d9d33f08b51ac23924035b8b08147`

R02 `complete-within-view` หมายถึง projection นี้เท่านั้น Parent application และ semantic graphs เป็น partial การเก็บ complete record ไม่ได้แปลว่าวิเคราะห์แอปครบทุกส่วน S/N IDs เป็น ledger IDs ของ shell inspection ไม่ใช่ REA IDs

## ตรวจ complete Evidence

รันจาก repository root; คำสั่งต่อไปนี้อ่านข้อมูลและสร้างไฟล์ชั่วคราวเท่านั้น ไม่รัน Termius:

```sh
gzip -dc docs/termius/evidence/rea-application-evidence.json.gz > /private/tmp/ssterm-rea-parent.json
shasum -a 256 /private/tmp/ssterm-rea-parent.json
```

เทียบ file SHA256 กับ `canonical_json_file_sha256` ใน metadata ซึ่งมีความหมายต่างจาก REA Evidence ID และ ASAR SHA256 ใช้ REA `inspect-analysis-view` กับ input JSON รูปแบบ `source.kind=inline`, `source.evidence=<complete parent object>`, `view.kind=summary` หรือ selected module page/item ตาม actual CLI schema ไม่ส่ง compressed file ตรงเป็น Evidence object

## Re-run focused analysis เมื่อจำเป็น

ใช้ existing REA launcher ที่ compatible; การตรวจครั้งนี้ใช้ `rea-agents@6.5.0` arguments ที่แน่นอนอยู่ใน metadata หาก artifact SHA256 เปลี่ยนต้องสร้าง investigation ใหม่ การ rerun อาจสร้าง Evidence ID ต่างออกไปเพราะ environment/provenance

```sh
npm_config_cache=/private/tmp/ssterm-rea-npm-cache npx -y rea-agents@6.5.0 --version
```

คำสั่งนี้อาจดาวน์โหลด package; ไม่ใช่การตั้งค่า MCP ใช้ `REA_DARWIN_MODULE_CACHE_PATH` ใน writable temp directory สำหรับ macOS helper compiler และ source paths/heap/node limits ตาม metadata การลด source selection เป็น intentional boundary ไม่ได้แก้ความไม่แน่นอนของไฟล์ที่ไม่เลือก

ผล REA มี native companion integrity mismatch 17 รายการ จึงใช้ `--integrity-policy record-and-continue` และคง `observed-untrusted`; ห้ามอ้างว่า mismatch พิสูจน์การ tamper หรือการลงนามเป็นสาเหตุโดยไม่มี evidence เพิ่ม การพยายามวิเคราะห์ bundle ใหญ่ก่อนหน้าเจอ worker heap exhaustion; ตรวจ worker exited ก่อนทำ focused analysis สำเร็จ

ไม่มี native analysis session เปิดค้าง ไม่มีการทำ REA setup, เปลี่ยน Codex config, launch target หรือใช้งาน Termius account
