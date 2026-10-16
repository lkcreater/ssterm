/** Renderer mirror of the domain `queryCatalogHosts` plus pure view helpers; a unit test keeps search parity. */
import type {
  CatalogEffective,
  CatalogGroup,
  CatalogHost,
  CatalogState,
} from "@ssterm/contracts";

export type CatalogScope =
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "group"; groupId: string };
export interface CatalogFilter {
  scope: CatalogScope;
  search: string;
  tagIds: readonly string[];
}
type Source = CatalogEffective["portSource"];

export const normalized = (value: string): string =>
  value.trim().normalize("NFC").toLowerCase();
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export const compareLabel = (
  a: { label: string; id: string },
  b: { label: string; id: string },
): number =>
  compareText(normalized(a.label), normalized(b.label)) ||
  compareText(a.id, b.id);

/** `user@host:port`; stored IPv6 addresses are unbracketed, so a colon means one. */
export const endpointText = (
  address: string,
  port: number,
  username?: string | null,
): string =>
  `${username ? `${username}@` : ""}${address.includes(":") ? `[${address}]` : address}:${port}`;

/** A group scope always includes descendants (sidebar selection). */
export function filterCatalogHosts(
  state: Pick<CatalogState, "hosts" | "tags" | "identities">,
  { scope, search, tagIds }: CatalogFilter,
): CatalogHost[] {
  const tagLabels = new Map(state.tags.map((tag) => [tag.id, tag]));
  const usernames = new Map(
    state.identities.map((identity) => [identity.id, identity.username]),
  );
  const needle = normalized(search);
  return state.hosts
    .filter((host) => {
      if (scope.kind === "ungrouped" && host.groupId !== null) return false;
      if (
        scope.kind === "group" &&
        !host.ancestry.some((group) => group.id === scope.groupId)
      )
        return false;
      if (tagIds.some((id) => !host.tagIds.includes(id))) return false;
      if (!needle) return true;
      const fields = [
        host.label,
        host.address,
        effectiveUsername(host, usernames) ?? "",
        ...host.tagIds.flatMap((id) => tagLabels.get(id)?.label ?? []),
        ...host.ancestry.map((group) => group.label),
      ];
      return fields.some((field) => normalized(field).includes(needle));
    })
    .sort(compareLabel);
}

function effectiveUsername(
  host: CatalogHost,
  usernames: ReadonlyMap<string, string>,
): string | undefined {
  const { authSelection, identityId } = host.effective;
  return authSelection === "identity" && identityId
    ? usernames.get(identityId)
    : undefined;
}

export interface GroupNode {
  group: CatalogGroup;
  depth: number;
  children: GroupNode[];
}
/** Same ordering as the domain `catalogGroupTree`. */
export function groupTree(groups: readonly CatalogGroup[]): GroupNode[] {
  const children = new Map<string | null, CatalogGroup[]>();
  for (const group of groups) {
    const siblings = children.get(group.parentId) ?? [];
    siblings.push(group);
    children.set(group.parentId, siblings);
  }
  const build = (parentId: string | null, depth: number): GroupNode[] =>
    (children.get(parentId) ?? [])
      .sort(compareLabel)
      .map((group) => ({ group, depth, children: build(group.id, depth + 1) }));
  return build(null, 0);
}
/** Depth-first rows for a flat Select; `exclude` drops that group and its subtree (move target). `path` tells same-named groups apart. */
export function groupOptions(
  tree: readonly GroupNode[],
  exclude?: string,
  parents: readonly string[] = [],
): { id: string; label: string; depth: number; path: string }[] {
  return tree.flatMap((node) => {
    if (node.group.id === exclude) return [];
    const path = [...parents, node.group.label];
    return [
      { id: node.group.id, label: node.group.label, depth: node.depth, path: path.join(" / ") },
      ...groupOptions(node.children, exclude, path),
    ];
  });
}
export function groupPath(
  groups: ReadonlyMap<string, CatalogGroup>,
  id: string | null,
): string[] {
  const path: string[] = [];
  for (let group = id ? groups.get(id) : undefined; group; ) {
    path.unshift(group.label);
    group = group.parentId ? groups.get(group.parentId) : undefined;
  }
  return path;
}

/** `self` is the group whose own values are shown, so its own override reads "set on this group". */
export function provenance(
  source: Source,
  groups: ReadonlyMap<string, CatalogGroup>,
  self?: string,
): string {
  if (source.kind === "host") return "set on this server";
  if (source.kind === "group")
    return source.id === self
      ? "set on this group"
      : `from group ${groups.get(source.id)?.label ?? "(unavailable)"}`;
  return "default";
}

const defaults: CatalogEffective = {
  port: 22,
  portSource: { kind: "default" },
  authSelection: "none",
  identityId: null,
  authSource: { kind: "default" },
};
/** What a direct member that inherits everything receives from `group` (none: the built-in defaults). */
export function memberDefaults(group: CatalogGroup | undefined): CatalogEffective {
  if (!group) return defaults;
  const own = { kind: "group" as const, id: group.id };
  const { port, auth, inherited } = group;
  return {
    ...(port.mode === "value"
      ? { port: port.port, portSource: own }
      : { port: inherited.port, portSource: inherited.portSource }),
    ...(auth.mode === "inherit"
      ? {
          authSelection: inherited.authSelection,
          identityId: inherited.identityId,
          authSource: inherited.authSource,
        }
      : auth.mode === "clear"
        ? { authSelection: "clear", identityId: null, authSource: own }
        : { authSelection: "identity", identityId: auth.identityId, authSource: own }),
  };
}
