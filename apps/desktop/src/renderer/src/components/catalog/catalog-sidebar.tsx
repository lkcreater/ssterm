import { useMemo, type ReactNode } from "react";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  InboxIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
} from "lucide-react";
import type { CatalogState } from "@ssterm/contracts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { CatalogScope, GroupNode } from "@/lib/catalog-filter";

/** The sidebar's Groups "+": the existing New server / New group menu. */
export function CatalogAddMenu({ disabled, onAdd }: { disabled: boolean; onAdd(kind: "host" | "group"): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarGroupAction disabled={disabled} />} aria-label="Add server or group">
        <PlusIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAdd("host")}>
            <ServerIcon /> New server
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAdd("group")}>
            <FolderPlusIcon /> New group
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Search and tag filter for the Servers page header. */
export function CatalogSearch({
  state,
  disabled,
  search,
  tagIds,
  resultCount,
  onSearch,
  onSubmit,
  onTags,
}: {
  state?: CatalogState;
  disabled: boolean;
  search: string;
  tagIds: string[];
  /** Present only while a search or tag filter is active. */
  resultCount?: number;
  onSearch(value: string): void;
  onSubmit(): void;
  onTags(ids: string[]): void;
}) {
  const anchor = useComboboxAnchor();
  const tags = state?.tags ?? [];
  const labels = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.label])), [tags]);
  const tagIdList = useMemo(() => tags.map((tag) => tag.id), [tags]);
  return (
    <>
      <div className="catalog-search flex flex-col gap-1">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search servers"
          placeholder="Search servers"
          value={search}
          disabled={disabled}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && search) {
              event.preventDefault();
              onSearch("");
            } else if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      </InputGroup>
      <p role="status" className="type-caption text-muted-foreground">
        {resultCount === undefined
          ? ""
          : resultCount === 0
            ? "No servers found"
            : `${resultCount} ${resultCount === 1 ? "server" : "servers"} found`}
      </p>
      </div>
      {tags.length ? (
        <Combobox
          multiple
          items={tagIdList}
          value={tagIds}
          onValueChange={(ids: string[]) => onTags(ids)}
          itemToStringLabel={(id: string) => labels.get(id) ?? ""}
          disabled={disabled}
        >
          <ComboboxChips ref={anchor} className="catalog-tags">
            <ComboboxValue>
              {(values: string[]) => (
                <>
                  {values.map((id) => (
                    <ComboboxChip key={id} removeLabel={`Remove tag filter ${labels.get(id)}`}>{labels.get(id)}</ComboboxChip>
                  ))}
                  <ComboboxChipsInput
                    aria-label="Filter by tags"
                    placeholder={values.length ? "" : "Filter by tags"}
                  />
                </>
              )}
            </ComboboxValue>
          </ComboboxChips>
          <ComboboxContent anchor={anchor}>
            <ComboboxEmpty>No matching tags.</ComboboxEmpty>
            <ComboboxList>
              {(id: string) => (
                <ComboboxItem key={id} value={id}>
                  {labels.get(id)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      ) : null}
    </>
  );
}

export function CatalogLibrary({
  state,
  tree,
  current,
  expanded,
  action,
  onScope,
  onToggle,
}: {
  state?: CatalogState;
  /** Rendered beside the "Groups" label. */
  action?: ReactNode;
  tree: GroupNode[];
  /** The selected scope while the servers page is shown. */
  current?: CatalogScope;
  expanded: ReadonlySet<string>;
  onScope(scope: CatalogScope): void;
  onToggle(groupId: string, open: boolean): void;
}) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const host of state?.hosts ?? [])
      for (const group of host.ancestry)
        map.set(group.id, (map.get(group.id) ?? 0) + 1);
    return map;
  }, [state]);
  const hosts = state?.hosts ?? [];
  const ungrouped = hosts.filter((host) => host.groupId === null).length;
  const disabled = state?.availability !== "ready";
  const item = (scope: CatalogScope) =>
    current?.kind === scope.kind &&
    (scope.kind !== "group" ||
      (current.kind === "group" && current.groupId === scope.groupId));
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Groups</SidebarGroupLabel>
      {action}
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={item({ kind: "all" })}
              aria-current={item({ kind: "all" }) ? "page" : undefined}
              disabled={disabled}
              onClick={() => onScope({ kind: "all" })}
            >
              <ServerIcon />
              <span>All servers</span>
              <span className="ml-auto type-caption">{hosts.length}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={item({ kind: "ungrouped" })}
              aria-current={item({ kind: "ungrouped" }) ? "page" : undefined}
              disabled={disabled}
              onClick={() => onScope({ kind: "ungrouped" })}
            >
              <InboxIcon />
              <span>Ungrouped</span>
              <span className="ml-auto type-caption">{ungrouped}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {tree.map((node) => (
            <GroupItem
              key={node.group.id}
              node={node}
              counts={counts}
              expanded={expanded}
              isCurrent={(id) => item({ kind: "group", groupId: id })}
              onScope={onScope}
              onToggle={onToggle}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GroupItem({
  node,
  counts,
  expanded,
  isCurrent,
  onScope,
  onToggle,
  nested = false,
}: {
  node: GroupNode;
  counts: ReadonlyMap<string, number>;
  expanded: ReadonlySet<string>;
  isCurrent(id: string): boolean;
  onScope(scope: CatalogScope): void;
  onToggle(groupId: string, open: boolean): void;
  nested?: boolean;
}) {
  const { group, children } = node;
  const open = expanded.has(group.id);
  const current = isCurrent(group.id);
  const content = (
    <>
      <FolderIcon />
      <span className="min-w-0 flex-1 truncate">{group.label}</span>
      <span className="type-caption">{counts.get(group.id) ?? 0}</span>
    </>
  );
  const select = {
    isActive: current,
    "aria-current": current ? ("page" as const) : undefined,
    onClick: () => onScope({ kind: "group", groupId: group.id }),
  };
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  return (
    <Item>
      <Collapsible
        open={open}
        onOpenChange={(next) => onToggle(group.id, next)}
      >
        {nested ? (
          <SidebarMenuSubButton
            render={<button type="button" />}
            className={children.length ? "w-full pr-8 text-left" : "w-full text-left"}
            {...select}
          >
            {content}
          </SidebarMenuSubButton>
        ) : (
          <SidebarMenuButton {...select}>{content}</SidebarMenuButton>
        )}
        {children.length ? (
          <>
            <CollapsibleTrigger
              render={<SidebarMenuAction className={nested ? "top-1" : undefined} />}
              aria-label={`Subgroups of ${group.label}`}
            >
              <ChevronRightIcon
                className={open ? "rotate-90 motion-safe:transition-transform" : "motion-safe:transition-transform"}
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {children.map((child) => (
                  <GroupItem
                    key={child.group.id}
                    node={child}
                    counts={counts}
                    expanded={expanded}
                    isCurrent={isCurrent}
                    onScope={onScope}
                    onToggle={onToggle}
                    nested
                  />
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        ) : null}
      </Collapsible>
    </Item>
  );
}
