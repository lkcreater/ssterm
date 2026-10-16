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
    detail: page.getByTestId("host-detail"),
    server: page.getByTestId("server-editor"),
    group: page.getByTestId("group-editor"),
    search: page.getByRole("searchbox", { name: "Search servers" }),
    status: page.locator("p[role=status]").first(),
    row: (label: string) => hosts.locator("button[data-host-id]", { hasText: label }),
    rows: hosts.locator("button[data-host-id]"),
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
  await expect(h.hosts.getByRole("heading", { name: root })).toBeVisible();
  // The empty state's New group button is gone; focus lands on the new group's heading, not the body.
  await expect(h.hosts.getByRole("heading", { name: root })).toBeFocused();

  // Child group: the Add menu defaults to the selected group and shows what it inherits.
  await h.add("New group");
  await h.group.getByLabel("Name").fill(child);
  await expect(h.group.getByText(`Uses 2222, from group ${root}.`)).toBeVisible();
  await h.save(h.group);
  await expect(h.hosts.getByRole("heading", { name: child })).toBeVisible();
  await expect(h.hosts.getByText("No servers in this group", { exact: true })).toBeVisible();

  // A server in the child group inherits the root's port.
  await h.hosts.getByRole("button", { name: "Add server" }).click();
  await expect(h.server.getByLabel("Group", { exact: true })).toContainText(child);
  await h.server.getByLabel("Name").fill(web);
  await h.server.getByLabel("Address").fill("web-1.example.test");
  await h.save(h.server);
  await expect(h.detail).toContainText(web);
  await expect(h.detail).toContainText(`2222 · from group ${root}`);
  await expect(h.detail).toContainText(`${root} / ${child}`);

  // A sibling with its own port.
  await h.hosts.getByRole("button", { name: "Add server" }).click();
  await h.server.getByLabel("Name").fill(pinned);
  await h.server.getByLabel("Address").fill("10.0.0.5");
  await h.customPort(h.server, "2022");
  await h.save(h.server);
  await expect(h.detail).toContainText("2022 · set on this server");

  // Editing the parent's port moves the inheriting server and leaves the override alone.
  await h.nav(root).click();
  await h.hosts.getByRole("button", { name: "Edit group" }).click();
  await h.customPort(h.group, "2200");
  await h.group.getByRole("button", { name: "Save", exact: true }).click();
  await expect(h.group.getByText("This also changes 1 other server")).toBeVisible();
  await expect(h.group.getByRole("list", { name: "Affected servers" })).toContainText(web);
  await h.group.getByRole("button", { name: "Save changes" }).click();
  await expect(h.group).toHaveCount(0);
  await h.row(web).click();
  await expect(h.detail).toContainText(`2200 · from group ${root}`);
  await h.row(pinned).click();
  await expect(h.detail).toContainText("2022 · set on this server");

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
  const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await h.server.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await expect(h.server).toBeVisible();
  await expect(h.rows).toHaveCount(2);
  await h.server.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(discard.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await discard.getByRole("button", { name: "Discard" }).click();
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
    await expect(r.hosts.getByRole("heading", { name: root })).toBeVisible();
    await r.row(web).click();
    await expect(r.detail).toContainText(`2200 · from group ${root}`);
    await expect(r.detail).toContainText(`${root} / ${child}`);
    await r.row(pinned).click();
    await expect(r.detail).toContainText("2022 · set on this server");
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

  // Tags are toggled one at a time on the detail panel.
  await h.row(web).click();
  const tag = h.detail.getByRole("textbox", { name: "New tag" });
  await tag.fill("web");
  await tag.press("Enter");
  await expect(h.detail.getByRole("button", { name: "web", exact: true })).toHaveAttribute("aria-pressed", "true");
  await tag.fill("critical");
  await tag.press("Enter");
  await expect(h.detail.getByRole("button", { name: "critical", exact: true })).toHaveAttribute("aria-pressed", "true");
  await h.row(spare).click();
  await expect(h.detail.getByRole("heading", { name: spare })).toBeVisible();
  await h.detail.getByRole("button", { name: "web", exact: true }).click();
  await expect(h.detail.getByRole("button", { name: "web", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(h.row(spare)).toContainText("web");

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
  await expect(h.detail.getByRole("heading", { level: 3 })).toHaveText(await h.rows.nth(1).locator("span.font-medium").first().innerText());
  await h.search.focus();
  await page.keyboard.press("Escape");
  await expect(h.search).toHaveValue("");
  await expect(h.status).toHaveText("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll at 960×640").toBe(true);
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
  await h.row(relay).click();
  await h.detail.getByRole("button", { name: "Delete", exact: true }).click();
  let dialog = page.getByTestId("delete-host-dialog");
  await expect(dialog.getByRole("heading", { name: `Delete ${relay}?` })).toBeVisible();
  await expect(dialog.getByTestId("delete-impacts")).toHaveText("Also removes 1 tag assignment.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(h.rows).toHaveCount(3);
  await h.detail.getByRole("button", { name: "Delete", exact: true }).click();
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
  dialog = page.getByTestId("delete-group-dialog");
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
  await expect(h.hosts.getByRole("heading", { name: root })).toBeVisible();
  await expect(h.hosts.getByRole("heading", { name: root })).toBeFocused();
  await expect(h.rows).toHaveCount(2);
  await h.row(web).click();
  await expect(h.detail).toContainText(`2222 · from group ${root}`);
  await expect(h.detail.locator("dd").nth(1)).toHaveText(root);

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

  await h.row(web).click();
  await h.detail.getByRole("button", { name: "Edit", exact: true }).click();
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
  await expect(h.detail.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(h.detail).toContainText("moved.example.test");
  expect(desktop.errors).toEqual([]);
});

test("long PROD labels and tags truncate inside the list at 960×640, and IPv6 targets are bracketed", async ({ desktop }) => {
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
  await h.row(label).click();

  const list = h.hosts.getByRole("list", { name: "All servers servers" });
  const box = (await list.boundingBox())!;
  const badge = (await h.row(label).getByText("PROD", { exact: true }).boundingBox())!;
  expect(badge.x, "PROD badge starts inside the list").toBeGreaterThanOrEqual(box.x);
  expect(badge.x + badge.width, "PROD badge ends inside the list").toBeLessThanOrEqual(box.x + box.width);
  expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth), "no horizontal scroll in the list").toBe(true);
  await expect(h.row(label).locator(".host-target")).toHaveText("[fd00::10]:22");
  await expect(h.detail.locator(".host-target")).toHaveText("[fd00::10]:22");
  await expect(h.detail.locator("dd").first(), "the address field stays unbracketed").toHaveText("fd00::10");

  const card = (await h.detail.boundingBox())!;
  const toggle = (await h.detail.getByRole("button", { name: huge }).boundingBox())!;
  expect(toggle.x + toggle.width, "a 200-character tag toggle stays inside the card").toBeLessThanOrEqual(card.x + card.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Unbroken 200-character labels wrap inside the delete-group dialog.
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
  const dialog = page.getByTestId("delete-group-dialog");
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
