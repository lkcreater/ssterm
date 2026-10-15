import { pathToFileURL } from "node:url";

export interface RendererLocation {
  url: string;
  devOrigin?: string;
}

/** Packaged apps never consult the development server environment variable. */
export function rendererLocation(
  packaged: boolean,
  filePath: string,
  devURL?: string,
): RendererLocation {
  if (!packaged && devURL) {
    const url = new URL(devURL);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Invalid development renderer URL");
    }
    return { url: url.href, devOrigin: url.origin };
  }
  return { url: pathToFileURL(filePath).href };
}

export function contentSecurityPolicy(devOrigin?: string): string {
  const connect = devOrigin
    ? `${devOrigin} ${devOrigin.replace("http:", "ws:")}`
    : "'none'";
  // Vite's React Refresh preamble is inline only during development. The dev
  // entry is restricted to the selected loopback server; packaged scripts stay self-only.
  const script = devOrigin ? "'self' 'unsafe-inline'" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
