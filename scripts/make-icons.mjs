// Derives the macOS app icon from the supplied artwork (docs/logo/icon-logo.png) without modifying it.
// Output (ignored): artifacts/icons/ssterm.iconset/*.png, artifacts/icons/ssterm.icns, artifacts/icons/qa.json.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs/logo/icon-logo.png");
const out = join(root, "artifacts/icons");
const iconset = join(out, "ssterm.iconset");

/** Minimal reader for 8-bit RGBA, non-interlaced PNG (what sips writes), enough for alpha QA. */
export function readRgba(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left
        : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      const add = [0, left, up, (left + up) >> 1, paeth][filter];
      if (add === undefined) throw new Error("bad filter");
      pixels[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** Transparent corners, content bounds (alpha > 16) and padding as a share of the edge. */
export function alphaReport({ width, height, pixels }) {
  const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
  let left = width, right = -1, top = height, bottom = -1, partial = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = alpha(x, y);
      if (a > 16) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      if (a > 0 && a < 255) partial += 1;
    }
  const corners = [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)];
  const pad = (n) => Math.round((n / width) * 1000) / 10;
  return {
    width, height, corners, transparentCorners: corners.every((a) => a === 0),
    content: { left, top, right, bottom },
    paddingPercent: { left: pad(left), top: pad(top), right: pad(width - 1 - right), bottom: pad(height - 1 - bottom) },
    antialiasedPixels: partial,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await rm(out, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  // iconutil names: icon_<n>x<n>[@2x].png for 16, 32, 128, 256, 512.
  const entries = [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of entries)
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", String(size), String(size), source, "--out", join(iconset, name)], { stdio: "ignore" });
  for (const size of sizes)
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", String(size), String(size), source, "--out", join(out, `ssterm-${size}.png`)], { stdio: "ignore" });
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(out, "ssterm.icns")]);
  const qa = { source: { ...alphaReport(readRgba(await readFile(source))) }, sizes: {} };
  for (const size of sizes) qa.sizes[size] = alphaReport(readRgba(await readFile(join(out, `ssterm-${size}.png`))));
  await writeFile(join(out, "qa.json"), JSON.stringify(qa, null, 2) + "\n");
  console.log(JSON.stringify({ icns: join(out, "ssterm.icns"), source: qa.source, s16: qa.sizes[16], s1024: qa.sizes[1024] }, null, 2));
}
