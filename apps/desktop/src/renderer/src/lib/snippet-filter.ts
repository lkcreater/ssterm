/** Snippet list search and editor checks. Bodies are never searched: only labels and tag labels (domain-storage-spec). */
import { MAX_SNIPPET_BODY_BYTES, type CatalogSnippet, type CatalogTag, type SaveSnippetResponse } from "@ssterm/contracts";
import { normalized } from "./catalog-filter";

export function filterSnippets(
  snippets: readonly CatalogSnippet[],
  tags: readonly CatalogTag[],
  search: string,
): CatalogSnippet[] {
  const terms = normalized(search).split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...snippets];
  const labels = new Map(tags.map((tag) => [tag.id, normalized(tag.label)]));
  return snippets.filter((snippet) => {
    const text = [normalized(snippet.label), ...snippet.tagIds.map((id) => labels.get(id) ?? "")];
    return terms.every((term) => text.some((value) => value.includes(term)));
  });
}

/** UTF-8 size of a body as main will store it. */
export const bodyBytes = (body: string): number => new TextEncoder().encode(body).byteLength;

export function bodyError(body: string): string | undefined {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body))
    return "Remove the broken character from the body.";
  if (bodyBytes(body) > MAX_SNIPPET_BODY_BYTES) return "Keep the body to 1 MiB or less.";
}

/** Field messages for main's typed save problems. */
export function saveFieldError(response: Extract<SaveSnippetResponse, { status: "invalid" }>): { field: "label" | "body" | "tag"; text: string } {
  switch (response.field) {
    case "label":
      return {
        field: "label",
        text: response.code === "empty" ? "Enter a name." : response.code === "too-long" ? "Use 200 characters or fewer." : "Remove control characters.",
      };
    case "body":
      return { field: "body", text: response.code === "too-large" ? "Keep the body to 1 MiB or less." : "Remove the broken character from the body." };
    default:
      return { field: "tag", text: "A selected tag was removed. Review the tags and save again." };
  }
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}
