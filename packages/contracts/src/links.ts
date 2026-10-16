import { exactObject, isOwner, type Owner } from "./index.ts";

export const MAX_LINK_URL = 2048;
export interface OpenLinkRequest { owner: Owner; url: string }
export interface OpenLinkResponse { opened: boolean }

export function isOpenLinkRequest(v: unknown): v is OpenLinkRequest {
  return exactObject(v, ["owner", "url"]) && isOwner(v.owner) &&
    typeof v.url === "string" && v.url.length > 0 && v.url.length <= MAX_LINK_URL;
}
export function isOpenLinkResponse(v: unknown): v is OpenLinkResponse {
  return exactObject(v, ["opened"]) && typeof v.opened === "boolean";
}
