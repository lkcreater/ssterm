import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";
import type {
  TeamAction,
  TeamReply,
  TeamView,
} from "../../packages/contracts/src/team";
import { TeamServer } from "../../apps/sync-server/src/team-server";
import { test, expect, launchDesktop, type Desktop } from "./fixtures";
import { expectDrawerPlaced } from "./support/drawer";
test.use({ trace: "off", screenshot: "off", video: "off" });
async function command(
  page: Page,
  action: TeamAction,
  success = true,
): Promise<TeamReply> {
  const r = await page.evaluate(async (action) => {
    const b = await window.ssterm.bootstrap();
    return b.ok
      ? window.ssterm.teamCommand({ owner: b.value.owner, action })
      : null;
  }, action);
  expect(r?.ok, `Team ${action.type} reaches production main`).toBe(true);
  if (!r?.ok) throw Error("Team bridge unavailable");
  if (success)
    expect(r.value.outcome, `Team ${action.type} (${r.value.code})`).toBe("ok");
  return r.value;
}
async function state(page: Page): Promise<TeamView> {
  const r = await page.evaluate(async () => {
    const b = await window.ssterm.bootstrap();
    return b.ok ? window.ssterm.teamState({ owner: b.value.owner }) : null;
  });
  expect(r?.ok).toBe(true);
  if (!r?.ok) throw Error("Team state unavailable");
  return r.value;
}
test("team human roles enforce production IPC, encrypted stores, managed SSH and observed revocation", async ({
  desktop,
}) => {
  test.setTimeout(360000);
  const directory = await mkdtemp(join(tmpdir(), "ssterm-team-e2e-"));
  const scope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    teamId: randomUUID(),
    metadataVaultId: randomUUID(),
    credentialVaultId: randomUUID(),
  };
  const principalId = randomUUID(),
    token = randomBytes(32).toString("base64url");
  const server = new TeamServer(
    {
      scope,
      initialOwnerPrincipalId: principalId,
      initialOwnerTokenHash: createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
      databasePath: join(directory, "server.sqlite"),
    },
    { requestLimit: 10000 },
  );
  const endpoint = await server.listen();
  const profiles: Desktop[] = [];
  const { startFixture } = createRequire(import.meta.url)(
    "../../spikes/ssh-compat/src/fixture.cjs",
  );
  const lab = await startFixture();
  const label = "Team lab ไทย " + randomUUID(),
    recordId = randomUUID();
  try {
    await command(desktop.page, {
      type: "create",
      endpoint,
      expectedScope: scope,
      principalId,
      token,
      displayName: "Owner fixture",
      consent: true,
    });
    let owner = await state(desktop.page);
    await command(desktop.page, {
      type: "save-host",
      record: {
        recordId,
        label,
        address: lab.host,
        port: lab.port,
        username: lab.username,
        environment: "DEV",
      },
      expectedMetadataHash: owner.metadataHash!,
    });
    // The fixture password crosses the renderer only as transient typed bytes, never stored React state.
    const shared = await desktop.page.evaluate(
      async ({ password, recordId }) => {
        const b = await window.ssterm.bootstrap();
        if (!b.ok) return null;
        const s = await window.ssterm.teamState({ owner: b.value.owner });
        if (!s.ok) return null;
        const bytes = new TextEncoder().encode(password);
        try {
          return await window.ssterm.teamCommand({
            owner: b.value.owner,
            action: {
              type: "share-password",
              recordId,
              password: bytes,
              consent: true,
              expectedMetadataHash: s.value.metadataHash!,
              expectedCredentialHash: s.value.credentialHash!,
            },
          });
        } finally {
          bytes.fill(0);
        }
      },
      { password: lab.password, recordId },
    );
    expect(shared?.ok && shared.value.outcome === "ok").toBe(true);
    // SST-040/06: the managed host editor, shared password and delete confirmation are drawers; Esc and Cancel change nothing.
    await desktop.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    const ownerHosts = desktop.page.getByTestId("team-workspace");
    await ownerHosts
      .getByRole("button", { name: `Edit Team host ${label}`, exact: true })
      .click();
    const hostDrawer = desktop.page.getByTestId("team-host-drawer");
    await expect(
      hostDrawer.getByLabel("Team host label", { exact: true }),
    ).toHaveValue(label);
    await expectDrawerPlaced(desktop.page, "team-host");
    await desktop.page.keyboard.press("Escape");
    await expect(hostDrawer).toHaveCount(0);
    await ownerHosts
      .getByRole("button", { name: `Share password for ${label}`, exact: true })
      .click();
    const passwordDrawer = desktop.page.getByTestId("team-password-drawer");
    await expect(passwordDrawer).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(
      passwordDrawer.getByLabel("Shared SSH password", { exact: true }),
    ).toHaveValue("");
    await expect(
      passwordDrawer.getByRole("button", { name: "Encrypt and share password" }),
    ).toBeDisabled();
    await expectDrawerPlaced(desktop.page, "team-password");
    await passwordDrawer.getByRole("button", { name: "Cancel" }).click();
    await expect(passwordDrawer).toHaveCount(0);
    await ownerHosts
      .getByRole("button", { name: `Delete Team host ${label}`, exact: true })
      .click();
    const confirmDelete = desktop.page.getByTestId("team-confirm-drawer");
    await expect(confirmDelete).toHaveAttribute("role", "alertdialog");
    await expect(
      confirmDelete.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await expectDrawerPlaced(desktop.page, "team-confirm");
    await confirmDelete.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDelete).toHaveCount(0);
    expect((await state(desktop.page)).hosts.map((host) => host.label)).toEqual([
      label,
    ]);
    const enroll = async (role: "Viewer" | "Connector" | "Editor") => {
      const invite = await command(desktop.page, {
        type: "invite",
        label: role + " fixture",
        role,
      });
      if (invite.detail.kind !== "invitation")
        throw Error("Missing invitation");
      const i = invite.detail.invitation;
      const profile = join(directory, role);
      await mkdir(profile);
      const member = await launchDesktop(profile);
      profiles.push(member);
      const candidate = await command(member.page, {
        type: "begin-join",
        endpoint,
        expectedScope: scope,
        principalId: i.principalId,
        token: i.token,
        expectedOwnerFingerprint: i.ownerFingerprint,
        consent: true,
      });
      if (candidate.detail.kind !== "text") throw Error("Missing candidate");
      const challenge = await command(desktop.page, {
        type: "challenge",
        candidateText: candidate.detail.text,
        principalId: i.principalId,
        role,
      });
      if (challenge.detail.kind !== "text") throw Error("Missing challenge");
      const proof = await command(member.page, {
        type: "prove",
        challengeText: challenge.detail.text,
      });
      if (proof.detail.kind !== "text" || !proof.detail.fingerprint)
        throw Error("Missing proof");
      await command(desktop.page, {
        type: "approve",
        proofText: proof.detail.text,
        confirmedFingerprint: proof.detail.fingerprint,
      });
      await command(member.page, { type: "finish-join" });
      return { member, invitation: i };
    };
    const viewer = await enroll("Viewer");
    let v = await state(viewer.member.page);
    expect(v.hosts[0].label).toBe(label);
    expect(v.credentialEpoch).toBe(0);
    const denied = await viewer.member.page.evaluate(async (id) => {
      const b = await window.ssterm.bootstrap();
      return b.ok
        ? window.ssterm.connectHost({ owner: b.value.owner, hostId: id })
        : null;
    }, v.hosts[0].virtualHostId);
    expect(denied?.ok).toBe(true);
    if (!denied?.ok) throw Error("Session admission unavailable");
    await expect
      .poll(() =>
        viewer.member.page.evaluate(async (sessionId) => {
          const b = await window.ssterm.bootstrap();
          if (!b.ok) return null;
          const s = await window.ssterm.terminalState({ owner: b.value.owner });
          return s.ok
            ? s.value.sessions.find((s) => s.sessionId === sessionId)?.phase
            : null;
        }, denied.value.sessionId),
      )
      .toBe("failed");
    await expect(
      viewer.member.page.getByTestId("host-trust-dialog"),
    ).toHaveCount(0);
    const forbidden = await command(
      viewer.member.page,
      {
        type: "save-host",
        record: {
          recordId,
          label: "denied",
          address: lab.host,
          port: lab.port,
          username: lab.username,
          environment: "DEV",
        },
        expectedMetadataHash: v.metadataHash!,
      },
      false,
    );
    expect(forbidden.outcome).toBe("failed");
    const connector = await enroll("Connector");
    const c = await state(connector.member.page);
    await connector.member.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    await expect(
      connector.member.page.getByTestId("team-workspace"),
    ).toContainText(label);
    // Role gating is unchanged: a Connector gets Connect, not the Editor/Owner drawers.
    await expect(
      connector.member.page.getByRole("button", {
        name: `Edit Team host ${label}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      connector.member.page.getByRole("button", {
        name: `Share password for ${label}`,
        exact: true,
      }),
    ).toHaveCount(0);
    // Production connect must use managed credentials after ordinary explicit SSH host trust.
    await connector.member.page
      .getByRole("button", {
        name: `Connect to Team host ${label}`,
        exact: true,
      })
      .click();
    const trust = connector.member.page.getByTestId("host-trust-dialog");
    await expect(trust).toBeVisible();
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    const pane = connector.member.page
      .locator(`section[aria-label="Terminal for ${label}"]`)
      .last();
    await expect(pane).toHaveAttribute("data-phase", "ready", {
      timeout: 20000,
    });
    await expect(pane.getByLabel("Team vault host")).toBeVisible();
    await pane
      .getByRole("button", { name: "Pane actions", exact: true })
      .click();
    // The absence check passes before the menu exists: wait until it is open and focused, or Escape can arrive
    // before the menu takes focus and leave it open (its modal backdrop then blocks every later click).
    const menu = connector.member.page.getByRole("menu", {
      name: "Pane actions",
      exact: true,
    });
    await expect(menu).toBeFocused();
    await expect(
      connector.member.page.getByRole("menuitem", {
        name: "Open in SFTP",
        exact: true,
      }),
    ).toHaveCount(0);
    await connector.member.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(
      connector.member.page.getByTestId("credential-prompt-dialog"),
    ).toHaveCount(0);
    await command(connector.member.page, {
      type: "logout",
      forgetTransportToken: false,
    });
    await expect(pane).not.toHaveAttribute("data-phase", "ready");
    expect((await state(connector.member.page)).status).toBe("locked");
    const resumed = await command(connector.member.page, { type: "fetch" });
    expect(resumed.state.status).toBe("enrolled");
    await connector.member.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    await connector.member.page
      .getByRole("button", {
        name: `Connect to Team host ${label}`,
        exact: true,
      })
      .click();
    await expect(pane).toHaveAttribute("data-phase", "ready", {
      timeout: 20000,
    });
    const editor = await enroll("Editor");
    const e = await state(editor.member.page);
    await command(editor.member.page, {
      type: "save-host",
      record: {
        recordId,
        label: label + " edited",
        address: lab.host,
        port: lab.port,
        username: lab.username,
        environment: "DEV",
      },
      expectedMetadataHash: e.metadataHash!,
    });
    const noAdmin = await command(
      editor.member.page,
      { type: "invite", label: "denied", role: "Viewer" },
      false,
    );
    expect(noAdmin.outcome).toBe("failed");
    await command(desktop.page, { type: "fetch" });
    let currentOwner = await state(desktop.page);
    await command(desktop.page, {
      type: "change-role",
      principalId: editor.invitation.principalId,
      role: "Viewer",
      expectedPolicyHash: currentOwner.policyHash!,
    });
    currentOwner = await state(desktop.page);
    const replacement = await command(desktop.page, {
      type: "reissue-token",
      principalId: editor.invitation.principalId,
      expectedPolicyHash: currentOwner.policyHash!,
    });
    if (replacement.detail.kind !== "invitation")
      throw Error("Replacement invitation unavailable");
    await command(editor.member.page, { type: "fetch" }, false);
    await editor.member.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    const rejoin = editor.member.page.getByTestId("team-workspace");
    await rejoin
      .getByRole("button", {
        name: "Request fresh Team device approval",
        exact: true,
      })
      .click();
    // The setup drawer opens in Join mode with the captured scope; only the replacement token is typed.
    const joinDrawer = editor.member.page.getByTestId("team-setup-drawer");
    await expect(joinDrawer.getByLabel("Team server URL", { exact: true })).toHaveValue(endpoint);
    await expect(joinDrawer.getByLabel("Principal ID", { exact: true })).toHaveValue(
      editor.invitation.principalId,
    );
    await joinDrawer
      .getByLabel("Principal token", { exact: true })
      .fill(replacement.detail.invitation.token);
    await joinDrawer
      .getByRole("checkbox", {
        name: "I choose this server and understand the Team connection and sharing policy.",
      })
      .check();
    await joinDrawer
      .getByRole("button", { name: "Create Team device request", exact: true })
      .click();
    await expect(joinDrawer).toHaveCount(0);
    const candidateResult = rejoin.getByLabel("Public enrollment text", {
      exact: true,
    });
    await expect(candidateResult).toBeVisible();
    const reChallenge = await command(desktop.page, {
      type: "challenge",
      candidateText: await candidateResult.inputValue(),
      principalId: editor.invitation.principalId,
      role: "Viewer",
    });
    if (reChallenge.detail.kind !== "text")
      throw Error("Reapproval challenge unavailable");
    const reProof = await command(editor.member.page, {
      type: "prove",
      challengeText: reChallenge.detail.text,
    });
    if (reProof.detail.kind !== "text" || !reProof.detail.fingerprint)
      throw Error("Reapproval proof unavailable");
    await command(desktop.page, {
      type: "approve",
      proofText: reProof.detail.text,
      confirmedFingerprint: reProof.detail.fingerprint,
    });
    await command(editor.member.page, { type: "finish-join" });
    expect((await state(editor.member.page)).role).toBe("Viewer");
    owner = await state(desktop.page);
    const epoch = owner.metadataEpoch;
    await command(desktop.page, {
      type: "revoke-principal",
      principalId: connector.invitation.principalId,
      expectedPolicyHash: owner.policyHash!,
    });
    expect((await state(desktop.page)).metadataEpoch).toBe(epoch + 1);
    await command(connector.member.page, { type: "fetch" }, false);
    await expect(pane).not.toHaveAttribute("data-phase", "ready");
    expect((await state(connector.member.page)).status).toBe("revoked");
    // Decrypted labels/passwords are absent from both client SQL journals and server SQL.
    for (const file of [
      "server.sqlite",
      "Connector/team/team.sqlite",
      "Viewer/team/team.sqlite",
    ]) {
      const bytes = Buffer.concat(
        await Promise.all(
          ["", "-wal", "-shm"].map((suffix) =>
            readFile(join(directory, file + suffix)).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return Buffer.alloc(0);
              throw error;
            }),
          ),
        ),
      );
      expect(bytes.includes(Buffer.from(lab.password))).toBe(false);
      expect(bytes.includes(Buffer.from(label))).toBe(false);
    }
    await desktop.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    const ownerPage = desktop.page.getByTestId("team-workspace");
    await expect(ownerPage).toContainText("Owner");
    // SST-040/06: a member's role, token and revocation are steps in one drawer; Esc steps back, then closes.
    // This page instance still shows the view from before the later members; fetch it from the page.
    await ownerPage.getByRole("button", { name: "Fetch Team changes", exact: true }).click();
    await ownerPage.getByRole("button", { name: /^Manage / }).first().click();
    const memberDrawer = desktop.page.getByTestId("team-member-drawer");
    await memberDrawer.getByRole("button", { name: "Revoke member", exact: true }).click();
    await expect(memberDrawer.getByTestId("team-member-confirm")).toBeVisible();
    await expect(memberDrawer.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectDrawerPlaced(desktop.page, "team-member");
    await desktop.page.keyboard.press("Escape");
    await expect(memberDrawer.getByTestId("team-member-confirm")).toHaveCount(0);
    await expect(memberDrawer.getByRole("button", { name: "Revoke member", exact: true })).toBeVisible();
    await desktop.page.keyboard.press("Escape");
    await expect(memberDrawer).toHaveCount(0);
    // SST-040/15: the invite and device-enrollment drawers open from the page; nothing typed, so Esc closes them.
    for (const [opener, testId] of [["Invite member", "team-invite-drawer"], ["Open device enrollment", "team-enrollment-drawer"]] as const) {
      await ownerPage.getByRole("button", { name: opener, exact: true }).click();
      const drawer = desktop.page.getByTestId(testId);
      await expect(drawer).toBeVisible();
      await expectDrawerPlaced(desktop.page, testId);
      await desktop.page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    }
    expect((await state(desktop.page)).members.filter((member) => member.status === "active")).toHaveLength(3);
  } finally {
    for (const p of profiles.reverse()) await p.close();
    await desktop.close();
    await lab.dispose();
    await lab.assertCleaned();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent Team recovery uses native kit dialogs and a fresh authority device without personal sync keys", async ({
  desktop,
}) => {
  test.setTimeout(240000);
  const directory = await mkdtemp(join(tmpdir(), "ssterm-team-recovery-e2e-"));
  const scope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    teamId: randomUUID(),
    metadataVaultId: randomUUID(),
    credentialVaultId: randomUUID(),
  };
  const principalId = randomUUID(),
    token = randomBytes(32).toString("base64url");
  const server = new TeamServer(
    {
      scope,
      initialOwnerPrincipalId: principalId,
      initialOwnerTokenHash: createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
      databasePath: join(directory, "server.sqlite"),
    },
    { requestLimit: 10000 },
  );
  const endpoint = await server.listen();
  let recovered: Desktop | undefined;
  try {
    await desktop.page
      .getByRole("button", { name: "Team vault", exact: true })
      .click();
    const panel = desktop.page.getByTestId("team-workspace");
    await panel
      .getByRole("button", { name: "Set up Team vault", exact: true })
      .click();
    const setup = desktop.page.getByTestId("team-setup-drawer");
    for (const [label, value] of Object.entries({
      "Team server URL": endpoint,
      "Deployment ID": scope.deploymentId,
      "Account ID": scope.accountId,
      "Team ID": scope.teamId,
      "Metadata vault ID": scope.metadataVaultId,
      "Credential vault ID": scope.credentialVaultId,
      "Principal ID": principalId,
      "Principal token": token,
    }))
      await setup.getByLabel(label, { exact: true }).fill(value);
    await setup
      .getByRole("checkbox", {
        name: "I choose this server and understand the Team connection and sharing policy.",
      })
      .check();
    await setup
      .getByRole("button", { name: "Create encrypted team", exact: true })
      .click();
    await expect(setup).toHaveCount(0);
    await expect(panel).toContainText("enrolled");
    const kitPath = join(directory, "owned-team-kit.ssterm");
    await desktop.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, kitPath);
    const draft = await command(desktop.page, { type: "create-recovery" });
    if (draft.detail.kind !== "recovery") throw Error("Missing recovery draft");
    const secret = draft.detail.secret;
    const encrypted = await readFile(kitPath);
    expect(encrypted.includes(Buffer.from(secret))).toBe(false);
    await command(desktop.page, {
      type: "confirm-recovery",
      confirmationToken: draft.detail.confirmationToken,
      secret,
    });
    const before = await state(desktop.page),
      recordId = randomUUID(),
      label = "After recovery kit ไทย";
    await command(desktop.page, {
      type: "save-host",
      record: {
        recordId,
        label,
        address: "127.0.0.1",
        port: 2222,
        username: "owned-fixture",
        environment: "PROD",
      },
      expectedMetadataHash: before.metadataHash!,
    });
    const fresh = join(directory, "fresh-owner");
    await mkdir(fresh);
    recovered = await launchDesktop(fresh);
    await recovered.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, kitPath);
    const fifo = join(directory, "owned-fifo");
    execFileSync("mkfifo", [fifo]);
    await recovered.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, fifo);
    const refused = await command(
      recovered.page,
      {
        type: "recover",
        endpoint,
        expectedScope: scope,
        principalId,
        token,
        expectedOwnerFingerprint: before.ownerFingerprint!,
        secret,
        consent: true,
      },
      false,
    );
    expect(refused.outcome).toBe("cancelled");
    expect((await state(recovered.page)).deviceId).toBe(null);
    await recovered.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, kitPath);
    const r = await command(recovered.page, {
      type: "recover",
      endpoint,
      expectedScope: scope,
      principalId,
      token,
      expectedOwnerFingerprint: before.ownerFingerprint!,
      secret,
      consent: true,
    });
    expect(r.state.role).toBe("Owner");
    expect(r.state.deviceId).not.toBe(before.deviceId);
    expect(r.state.metadataEpoch).toBe(before.metadataEpoch + 1);
    expect(r.state.ownerFingerprint).not.toBe(before.ownerFingerprint);
    const fetched = await command(recovered.page, { type: "fetch" });
    expect(fetched.state.hosts[0].recordId).toBe(recordId);
    expect(fetched.state.hosts[0].label).toBe(label);
    const old = await command(desktop.page, { type: "fetch" }, false);
    expect(old.outcome).toBe("failed");
    expect((await state(desktop.page)).role).toBe(null);
    const personal = await recovered.page.evaluate(async () => {
      const b = await window.ssterm.bootstrap();
      return b.ok ? window.ssterm.syncState({ owner: b.value.owner }) : null;
    });
    expect(personal?.ok && personal.value.status).toBe("disabled");
  } finally {
    await recovered?.close();
    await desktop.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
