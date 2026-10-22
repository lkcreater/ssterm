import type { Locator, Page } from "@playwright/test";
import { test, expect, launchDesktop, changeCatalog, type Desktop } from "./fixtures";

const root = "กลุ่มหลัก กรุงเทพ";
const child = "ฐานข้อมูล เชียงใหม่";
const web = "เครื่องเว็บ หนึ่ง";
const spare = "เครื่องสำรอง สอง";
const relay = "Relay ungrouped";
const pinned = "Pinned port box";

const ui = (page: Page) => {
  const hosts = page.getByTestId("hosts-page");
  return {
    hosts,
    /** The host drawer: the server editor, which also holds tags, the saved target and route. */
    server: page.getByTestId("server-editor"),
    heading: hosts.getByRole("heading", { name: "Servers", exact: true }),
    /** The Servers subtitle names the scope (All servers, Ungrouped or the group). */
    scope: page.getByTestId("hosts-scope"),
    group: page.getByTestId("group-editor"),
    search: page.getByRole("searchbox", { name: "Search servers" }),
    status: hosts.locator("p[role=status]").first(),
    row: (label: string) => hosts.locator("button[data-host-id]", { hasText: label }),
    rows: hosts.locator("button[data-host-id]"),
    /** A table row, by the server's name. */
    tr: (label: string) => hosts.getByRole("row").filter({ has: page.locator("button[data-host-id]", { hasText: label }) }),
    actions: (label: string) => hosts.getByRole("button", { name: `Actions for ${label}`, exact: true }),
    /** Activating a row opens the host drawer. */
    async open(label: string) {
      await hosts.locator("button[data-host-id]", { hasText: label }).click();
      await expect(page.getByTestId("server-editor").getByLabel("Name")).toHaveValue(label);
    },
    /** A clean drawer closes on Esc. */
    async close() {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("server-editor")).toHaveCount(0);
    },
    /** Sidebar library entries start with their label; the disclosure trigger starts with "Subgroups of". */
    nav: (label: string) => page.getByRole("button", { name: new RegExp(`^${label}`) }),
    async add(kind: "New server" | "New group") {
      await page.getByRole("button", { name: "Add server or group" }).click();
      await page.getByRole("menuitem", { name: kind }).click();
    },
    async choose(dialog: Locator, label: string, option: string) {
      await dialog.getByLabel(label, { exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    },
    async customPort(dialog: Locator, port: string) {
      const custom = dialog.getByRole("button", { name: "Custom", exact: true });
      if ((await custom.getAttribute("aria-pressed")) !== "true") await custom.click();
      await dialog.getByLabel("Custom port").fill(port);
    },
    async save(dialog: Locator) {
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    },
  };
};

/** Ids of a seeded tree: root (2222) → child; web and spare in child, relay ungrouped. */
async function seed(desktop: Desktop, extra: object[] = []) {
  const ids = await changeCatalog(desktop.app, [
    { type: "create-group", data: { label: root, port: { mode: "value", port: 2222 } } },
    { type: "create-group", data: { label: child, parentId: "$0" } },
    { type: "create-host", data: { label: web, address: "web-1.example.test", groupId: "$1" } },
    { type: "create-host", data: { label: spare, address: "db-2.example.test", groupId: "$1" } },
    { type: "create-host", data: { label: relay, address: "relay.example.test" } },
    ...extra,
  ]);
  // The open window learns of out-of-band changes only when it reloads its state.
  await desktop.page.reload();
  await expect(ui(desktop.page).rows).toHaveCount(3);
  return ids;
}

test("F01 builds a Thai group tree whose servers inherit, override, validate and persist across relaunch", async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page } = desktop;
  const h = ui(page);
  await expect(h.hosts.getByText("No servers yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add server or group" })).toBeEnabled();
  await expect(h.hosts.getByRole("button", { name: "Add server" })).toBeEnabled();

  // Root group from the empty state, with its own port.
  await h.hosts.getByRole("button", { name: "New group" }).click();
  await h.group.getByLabel("Name").fill(root);
  await h.customPort(h.group, "2222");
  await h.save(h.group);
  await expect(h.scope).toHaveText(root);
  // The empty state's New group button is gone; focus lands on the page heading, not the body.
  await expect(h.heading).toBeFocused();

  // Child group: the Add menu defaults to the selected group and shows what it inherits.
  await h.add("New group");
  await h.group.getByLabel("Name").fill(child);
  await expect(h.group.getByText(`Uses 2222, from group ${root}.`)).toBeVisible();
  await h.save(h.group);
  await expect(h.scope).toHaveText(child);
  await expect(h.hosts.getByText("No servers in this group", { exact: true })).toBeVisible();

  // A server in the child group inherits the root's port.
  await h.hosts.getByRole("button", { name: "Add server" }).click();
  await expect(h.server.getByLabel("Group", { exact: true })).toContainText(child);
  await h.server.getByLabel("Name").fill(web);
  await h.server.getByLabel("Address").fill("web-1.example.test");
  await h.save(h.server);
  // The new server is the current row; its drawer shows what it inherits and where it sits.
  await expect(h.row(web)).toHaveAttribute("aria-current", "true");
  await expect(h.tr(web).locator(".host-target")).toHaveText("web-1.example.test:2222");
  await h.open(web);
  await expect(h.server.getByText(`Uses 2222, from group ${root}.`)).toBeVisible();
  await expect(h.server.getByLabel("Group", { exact: true }).locator("[data-slot=select-value]")).toHaveText(`${root} / ${child}`);
  await h.close();

  // A sibling with its own port.
  await h.hosts.getByRole("button", { name: "Add server" }).click();
  await h.server.getByLabel("Name").fill(pinned);
  await h.server.getByLabel("Address").fill("10.0.0.5");
  await h.customPort(h.server, "2022");
  await h.save(h.server);
  await expect(h.tr(pinned).locator(".host-target")).toHaveText("10.0.0.5:2022");

  // Editing the parent's port moves the inheriting server and leaves the override alone.
  await h.nav(root).click();
  await h.hosts.getByRole("button", { name: "Edit group" }).click();
  await h.customPort(h.group, "2200");
  await h.group.getByRole("button", { name: "Save", exact: true }).click();
  await expect(h.group.getByText("This also changes 1 other server")).toBeVisible();
  await expect(h.group.getByRole("list", { name: "Affected servers" })).toContainText(web);
  await h.group.getByRole("button", { name: "Save changes" }).click();
  await expect(h.group).toHaveCount(0);
  await h.open(web);
  await expect(h.server.getByText(`Uses 2200, from group ${root}.`)).toBeVisible();
  await h.close();
  await h.open(pinned);
  await expect(h.server.getByLabel("Custom port")).toHaveValue("2022");
  await h.close();

  // Validation: inline errors, focus on the first invalid field, nothing saved.
  await h.hosts.getByRole("button", { name: "Add server" }).click();
  const name = h.server.getByLabel("Name");
  const address = h.server.getByLabel("Address");
  const save = h.server.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(h.server.getByText("Enter a name.")).toBeVisible();
  await expect(h.server.getByText("Enter a host name or IP address.")).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.fill("ก".repeat(201));
  await save.click();
  await expect(h.server.getByText("Use 200 characters or fewer.")).toBeVisible();
  await expect(name).toBeFocused();
  await name.fill("ก".repeat(200));
  await address.fill("bad host/path");
  await save.click();
  await expect(h.server.getByText("Use a host name or IP address only, without spaces, user names or paths.")).toBeVisible();
  await expect(address).toBeFocused();
  await address.fill("ok.example.test");
  await h.customPort(h.server, "0");
  await save.click();
  await expect(h.server.getByText("Enter a port from 1 to 65535.")).toBeVisible();
  await expect(h.server.getByLabel("Custom port")).toBeFocused();
  // A submit that reaches the form (an Enter typed before the prompt takes focus) must not save behind the discard prompt.
  await h.server.getByLabel("Custom port").fill("22");
  await page.keyboard.press("Escape");
  // The discard step replaces the form inside the same drawer; nothing is stacked over it.
  const discard = h.server.getByRole("alert", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await h.server.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(discard).toBeVisible();
  await h.server.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await expect(h.server).toBeVisible();
  await expect(h.server.getByLabel("Custom port")).toBeFocused();
  await expect(h.rows).toHaveCount(2);
  await h.server.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(h.server.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await h.server.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(h.server).toHaveCount(0);
  await expect(h.rows).toHaveCount(2);
  expect(desktop.errors).toEqual([]);

  // Relaunch on the same profile: the tree and resolved values persist.
  await desktop.close();
  const again = await launchDesktop(desktop.profile);
  try {
    const r = ui(again.page);
    await expect(r.rows).toHaveCount(2);
    await r.nav(root).click();
    await expect(r.scope).toHaveText(root);
    await r.open(web);
    await expect(r.server.getByText(`Uses 2200, from group ${root}.`)).toBeVisible();
    await expect(r.server.getByLabel("Group", { exact: true }).locator("[data-slot=select-value]")).toHaveText(`${root} / ${child}`);
    await r.close();
    await expect(r.tr(pinned).locator(".host-target")).toHaveText("10.0.0.5:2022");
    expect(again.errors).toEqual([]);
  } finally {
    await again.close();
  }
});

test("tags filter with AND, search matches Thai names, addresses and groups, and the list is keyboard operable", async ({ desktop }) => {
  test.setTimeout(90_000);
  const { app, page } = desktop;
  const h = ui(page);
  await seed(desktop);

  // A double-click opens the drawer once: its second press (on the scrim by then) does not dismiss it. On the name
  // and on a plain cell, with the second press 60 and 150 ms after the first.
  for (const [cell, gap] of [[h.row(relay), 60], [h.tr(relay).locator("td").nth(2), 150]] as const) {
    const box = (await cell.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(x, y);
    await page.waitForTimeout(gap);
    // The second press of a real double-click: down/up with click count 2 (mouse.click would press twice).
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await page.waitForTimeout(400);
    await expect(h.server.getByLabel("Name"), `double-click, ${gap} ms`).toHaveValue(relay);
    await expect(page.locator("[data-slot='drawer']")).toHaveCount(1);
    await h.close();
  }
  // The group path is in the name's tooltip; opening another row's ⋯ menu makes that row current.
  await expect(h.row(web)).toHaveAttribute("title", `${web} — ${root} / ${child}`);
  await h.actions(spare).click();
  // Esc only once the menu is open; an early one leaves the menu's backdrop over the page (cf. team.spec:42).
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(h.row(spare)).toHaveAttribute("aria-current", "true");
  await expect(h.actions(spare)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(h.row(spare), "Shift+Tab reaches the now-current row's name").toBeFocused();

  // Tags are toggled one at a time in the host drawer and apply at once, outside the draft.
  await h.open(web);
  const tag = h.server.getByRole("textbox", { name: "New tag" });
  await expect(h.server.getByText("Tags apply immediately, without Save.")).toBeVisible();
  await tag.fill("web");
  await tag.press("Enter");
  await expect(h.server.getByRole("button", { name: "web", exact: true })).toHaveAttribute("aria-pressed", "true");
  await tag.fill("critical");
  await tag.press("Enter");
  await expect(h.server.getByRole("button", { name: "critical", exact: true })).toHaveAttribute("aria-pressed", "true");
  await h.close();
  await h.open(spare);
  await h.server.getByRole("button", { name: "web", exact: true }).click();
  await expect(h.server.getByRole("button", { name: "web", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The tag change moved the server's revision; the draft is rebased on it, so a save right after is no conflict.
  await h.customPort(h.server, "2201");
  await h.save(h.server);
  await expect(h.tr(spare).locator(".host-target")).toHaveText("db-2.example.test:2201");

  const filter = page.getByRole("combobox", { name: "Filter by tags" });
  await filter.click();
  await page.getByRole("option", { name: "web", exact: true }).click();
  await expect(h.status).toHaveText("2 servers found");
  await filter.click();
  await page.getByRole("option", { name: "critical", exact: true }).click();
  await expect(h.status).toHaveText("1 server found");
  await expect(h.rows).toHaveCount(1);
  await expect(h.rows).toContainText(web);
  await page.keyboard.press("Escape");

  // Search combined with the tags finds nothing; one action clears both.
  await h.search.fill("relay");
  await expect(h.status).toHaveText("No servers found");
  await expect(h.hosts.getByText("No servers match", { exact: true })).toBeVisible();
  await h.hosts.getByRole("button", { name: "Clear search and tags" }).click();
  await expect(h.search).toHaveValue("");
  await expect(h.status).toHaveText("");
  await expect(h.rows).toHaveCount(3);

  for (const [query, expected] of [["เว็บ", [web]], ["db-2.example", [spare]], ["เชียงใหม่", [web, spare]], ["RELAY", [relay]]] as const) {
    await h.search.fill(query);
    await expect(h.rows, query).toHaveCount(expected.length);
    for (const label of expected) await expect(h.row(label), query).toBeVisible();
  }
  await h.search.fill("ไม่มีเครื่องนี้");
  await expect(h.hosts.getByText("No servers match", { exact: true })).toBeVisible();

  // Keyboard at the minimum window size with reduced motion.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
  await h.search.fill("example");
  await expect(h.status).toHaveText("3 servers found");
  await h.search.press("Enter");
  await expect(h.rows.nth(0)).toBeFocused();
  await expect(h.rows.nth(0)).toContainText(relay);
  await page.keyboard.press("ArrowDown");
  await expect(h.rows.nth(1)).toBeFocused();
  await expect(h.rows.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await expect(h.rows.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(h.rows.nth(1)).toBeFocused();
  // Enter opens the current row's host drawer; Esc returns focus to the row.
  const second = await h.rows.nth(1).innerText();
  await page.keyboard.press("Enter");
  await expect(h.server.getByLabel("Name")).toHaveValue(second);
  await h.close();
  await expect(h.rows.nth(1)).toBeFocused();
  // One tab stop for the table: Tab reaches the current row's Connect, then its ⋯ menu of the existing actions.
  await page.keyboard.press("Tab");
  await expect(h.hosts.getByRole("button", { name: `Connect ${second}`, exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(h.actions(second)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem")).toHaveText(["Edit", "Open files", "Delete"]);
  // No identity on these servers: Open files is unavailable, as Connect is.
  await expect(page.getByRole("menuitem", { name: "Open files" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(h.actions(second)).toBeFocused();
  // No sort controls and no row checkboxes (SST-040 decision 3).
  await expect(h.hosts.getByRole("checkbox")).toHaveCount(0);
  await expect(h.hosts.getByRole("columnheader")).toHaveText(["Name", "Address", "Identity", "Environment", "Status", "Actions"]);
  await h.search.focus();
  await page.keyboard.press("Escape");
  await expect(h.search).toHaveValue("");
  await expect(h.status).toHaveText("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll at 960×640").toBe(true);
  expect(await h.hosts.locator(".servers-frame").evaluate((el) => el.scrollWidth <= el.clientWidth), "no horizontal scroll in the table").toBe(true);
  expect(desktop.errors).toEqual([]);
});

test("deleting a server and groups states the impact, keeps Cancel focused and honors the chosen disposition", async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page } = desktop;
  const h = ui(page);
  // $5 = an empty subgroup of root, $6 = a tag on relay; the child group overrides root's port.
  await seed(desktop, [
    { type: "create-group", data: { label: "ว่างเปล่า", parentId: "$0" } },
    { type: "create-tag", data: { label: "edge" } },
    { type: "set-host-tag", hostId: "$4", tagId: "$6", present: true, expectedHostRevision: "current" },
    { type: "update-group", id: "$1", expectedRevision: "current", data: { port: { mode: "value", port: 2200 } } },
  ]);

  // Server: counts, Cancel focused, Escape closes without deleting.
  await h.actions(relay).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  let dialog = page.getByTestId("delete-host-drawer");
  await expect(dialog.getByRole("heading", { name: `Delete ${relay}?` })).toBeVisible();
  await expect(dialog.getByTestId("delete-impacts")).toHaveText("Also removes 1 tag assignment.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(h.rows).toHaveCount(3);
  await expect(h.actions(relay), "focus returns to the row's ⋯ menu").toBeFocused();
  await h.actions(relay).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete server" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(h.row(relay)).toHaveCount(0);
  await expect(h.rows).toHaveCount(2);
  // Focus moves to the newly selected row, which is the list's single tab stop.
  await expect(h.rows.nth(0)).toBeFocused();
  await expect(h.rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(h.rows.nth(1)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(h.rows.nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(h.rows.nth(0)).toBeFocused();

  // Child group: move its servers to the parent.
  await h.nav(root).click();
  await page.getByRole("button", { name: `Subgroups of ${root}` }).click();
  await h.nav(child).click();
  await h.hosts.getByRole("button", { name: "Delete group" }).click();
  dialog = page.getByTestId("delete-group-drawer");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Delete group" })).toBeDisabled();
  await dialog.getByRole("radio", { name: `Move them to group ${root}` }).click();
  await expect(dialog.getByTestId("delete-impacts")).toHaveText(
    `2 servers move to group ${root}; 2 servers' inherited port or identity changes.`,
  );
  const affected = dialog.getByRole("list", { name: "Affected servers" }).getByRole("listitem");
  await expect(affected).toHaveCount(2);
  await expect(affected.filter({ hasText: web })).toContainText("connection settings change");
  await dialog.getByRole("button", { name: "Delete group" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(h.scope).toHaveText(root);
  await expect(h.heading).toBeFocused();
  await expect(h.rows).toHaveCount(2);
  await h.open(web);
  await expect(h.server.getByText(`Uses 2222, from group ${root}.`)).toBeVisible();
  await expect(h.server.getByLabel("Group", { exact: true }).locator("[data-slot=select-value]")).toHaveText(root);
  await h.close();

  // Root group: delete everything inside it.
  await h.hosts.getByRole("button", { name: "Delete group" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("radio", { name: "Delete them with this group" }).click();
  await expect(dialog.getByTestId("delete-impacts")).toHaveText("Deletes 2 servers and 1 subgroup.");
  await dialog.getByRole("button", { name: "Delete group" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(h.hosts.getByText("No servers yet", { exact: true })).toBeVisible();
  expect(desktop.errors).toEqual([]);
});

test("a save after an out-of-band change shows the conflict, and Reload keeps the draft", async ({ desktop }) => {
  const { app, page } = desktop;
  const h = ui(page);
  const ids = await seed(desktop);
  const renamed = "เปลี่ยนชื่อจากที่อื่น";

  await h.open(web);
  await h.server.getByLabel("Address").fill("moved.example.test");
  // Another connection to this profile's catalog changes the same server.
  await changeCatalog(app, [{ type: "update-host", id: ids[2], expectedRevision: "current", data: { label: renamed } }]);
  await h.server.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = h.server.getByRole("alert").filter({ hasText: "Changed since you opened this" });
  await expect(conflict).toBeVisible();
  await expect(h.server.getByLabel("Address")).toHaveValue("moved.example.test");
  await conflict.getByRole("button", { name: "Reload" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(h.server.getByLabel("Name")).toHaveValue(renamed);
  await expect(h.server.getByLabel("Address"), "the draft survives the reload").toHaveValue("moved.example.test");
  await h.save(h.server);
  await expect(h.tr(renamed).locator(".host-target")).toHaveText("moved.example.test:2222");
  expect(desktop.errors).toEqual([]);
});

test("long PROD labels and tags truncate inside the table at 960×640 and 1280×800, and IPv6 targets are bracketed", async ({ desktop }, testInfo) => {
  const { app, page } = desktop;
  const h = ui(page);
  const label = "ฐานข้อมูลหลัก production primary 01".padEnd(38, "x");
  const tag = "t".repeat(48);
  const huge = "ก".repeat(200);
  await changeCatalog(app, [
    { type: "create-host", data: { label, address: "fd00::10", environment: "PROD" } },
    { type: "create-tag", data: { label: tag } },
    { type: "create-tag", data: { label: huge } },
    { type: "set-host-tag", hostId: "$0", tagId: "$1", present: true, expectedHostRevision: "current" },
    { type: "set-host-tag", hostId: "$0", tagId: "$2", present: true, expectedHostRevision: "current" },
  ]);
  await page.reload();
  const table = h.hosts.locator(".servers-frame");
  const row = h.tr(label);
  for (const [width, height] of [[1280, 800], [960, 640]] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height] as const);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    const box = (await table.boundingBox())!;
    const badge = (await row.getByText("PROD", { exact: true }).boundingBox())!;
    expect(badge.x, `${width}: PROD badge starts inside the table`).toBeGreaterThanOrEqual(box.x);
    expect(badge.x + badge.width, `${width}: PROD badge ends inside the table`).toBeLessThanOrEqual(box.x + box.width);
    expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth), `${width}: no horizontal scroll in the table`).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal page scroll`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`servers-${width}x${height}.png`) });
    // The long name truncates with its full text in the title, and both name and target keep a legible width.
    const name = h.row(label);
    await expect(name).toHaveAttribute("title", label);
    expect((await name.boundingBox())!.width, `${width}: the name stays legible`).toBeGreaterThanOrEqual(90);
    const target = row.locator(".host-target");
    await expect(target).toHaveText("[fd00::10]:22");
    await expect(target).toHaveAttribute("title", "[fd00::10]:22");
    expect(await target.evaluate((el) => el.scrollWidth <= el.clientWidth), `${width}: the whole target is shown`).toBe(true);
  }

  await h.open(label);
  await expect(h.server.getByLabel("Saved connection").locator(".host-target")).toHaveText("[fd00::10]:22");
  await expect(h.server.getByLabel("Address"), "the address field stays unbracketed").toHaveValue("fd00::10");
  const card = (await h.server.boundingBox())!;
  const toggle = (await h.server.getByRole("button", { name: huge }).boundingBox())!;
  expect(toggle.x + toggle.width, "a 200-character tag toggle stays inside the drawer").toBeLessThanOrEqual(card.x + card.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await h.close();

  // Unbroken 200-character labels wrap inside the delete-group drawer.
  const parent = "ค".repeat(200);
  await changeCatalog(app, [
    { type: "create-group", data: { label: parent, port: { mode: "value", port: 2222 } } },
    { type: "create-group", data: { label: "c", parentId: "$0", port: { mode: "value", port: 2200 } } },
    { type: "create-host", data: { label: "ข".repeat(200), address: "deep.example.test", groupId: "$1" } },
  ]);
  await page.reload();
  await h.nav(parent).click();
  await page.getByRole("button", { name: `Subgroups of ${parent}` }).click();
  await h.nav("c").click();
  await h.hosts.getByRole("button", { name: "Delete group" }).click();
  const dialog = page.getByTestId("delete-group-drawer");
  await expect(dialog).toContainText("Open sessions keep their current connection.");
  await dialog.getByRole("radio", { name: `Move them to group ${parent}` }).click();
  await expect(dialog.getByRole("list", { name: "Affected servers" })).toBeVisible();
  const frame = (await dialog.boundingBox())!;
  for (const part of [dialog.locator("label").first(), dialog.getByTestId("delete-impacts"), dialog.getByRole("list", { name: "Affected servers" })]) {
    const b = (await part.boundingBox())!;
    expect(b.x + b.width, "wraps inside the dialog").toBeLessThanOrEqual(frame.x + frame.width);
  }
  expect(await dialog.evaluate((el) => [el, ...el.children].every((n) => n.scrollWidth <= n.clientWidth)), "no horizontal scroll in the dialog").toBe(true);
  expect(desktop.errors).toEqual([]);
});
