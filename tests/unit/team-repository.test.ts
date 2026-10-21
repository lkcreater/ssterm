import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  openTeamRepository,
  TeamRepositoryFault,
} from "../../packages/adapters/src/team-repository.ts";
import { openSyncRepository } from "../../packages/adapters/src/sync-repository.ts";
import type { TeamPolicyCheckpoint } from "../../packages/domain/src/team.ts";
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "ssterm-team-repository-"));
  return {
    dir,
    path: join(dir, "team.sqlite"),
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
test("team repository is private separate schema identity and refuses personal/foreign databases or symlinks", () => {
  const f = fixture();
  try {
    const repo = openTeamRepository(f.path),
      identity = repo.identity();
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    repo.close();
    const reopened = openTeamRepository(f.path);
    assert.equal(reopened.identity(), identity);
    reopened.close();
    assert.throws(() => openSyncRepository(f.path));
    const foreign = join(f.dir, "foreign.sqlite");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE unrelated(value TEXT)");
    db.close();
    assert.throws(() => openTeamRepository(foreign));
    const link = join(f.dir, "link.sqlite");
    symlinkSync(f.path, link);
    assert.throws(() => openTeamRepository(link));
  } finally {
    f.close();
  }
});
test("virtual host bindings use reserved UUID namespace and durable permanent tombstones", () => {
  const f = fixture();
  try {
    let repo = openTeamRepository(f.path);
    const team = randomUUID(),
      record = randomUUID(),
      id = repo.bind(team, record);
    assert.match(
      id,
      /^7ea03700-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(repo.bind(team, record), id);
    repo.retireMissing(team, []);
    assert.equal(repo.binding(id)?.retired, true);
    assert.throws(() => repo.bind(team, record), TeamRepositoryFault);
    repo.close();
    repo = openTeamRepository(f.path);
    assert.equal(repo.binding(id)?.recordId, record);
    assert.equal(repo.binding(id)?.retired, true);
    repo.close();
  } finally {
    f.close();
  }
});
test("checkpoint budget refuses growth without pruning and immutable retries reject substitutions", () => {
  const f = fixture();
  try {
    const repo = openTeamRepository(f.path);
    const checkpoint = {
      policy: { body: { generation: 1 } },
      metadataControl: {},
      credentialControl: {},
    } as unknown as TeamPolicyCheckpoint;
    const row = { hash: "0".repeat(64), generation: 1, checkpoint };
    repo.addCheckpoint(row);
    repo.addCheckpoint(row);
    assert.throws(
      () =>
        repo.addCheckpoint({
          ...row,
          checkpoint: {
            ...checkpoint,
            metadataControl: { wraps: ["different"] },
          } as TeamPolicyCheckpoint,
        }),
      TeamRepositoryFault,
    );
    for (let i = 2; i <= 256; i++)
      repo.addCheckpoint({
        hash: i.toString(16).padStart(64, "0"),
        generation: i,
        checkpoint,
      });
    assert.throws(
      () =>
        repo.addCheckpoint({
          hash: "f".repeat(64),
          generation: 257,
          checkpoint,
        }),
      (e) => e instanceof TeamRepositoryFault && e.code === "too-large",
    );
    assert.equal(repo.checkpoints().length, 256);
    repo.close();
  } finally {
    f.close();
  }
});
test("provider and publication state transactions roll back together; pending enrollments expire on reopen", () => {
  const f = fixture();
  try {
    let repo = openTeamRepository(f.path);
    repo.set("provider/a", { account: "opaque-ref", digest: "public-digest" });
    assert.throws(() =>
      repo.transaction(() => {
        repo.set("pendingPublication", { ciphertext: "encrypted-wire" });
        repo.set("provider/a", { digest: "replacement" });
        throw new Error("owned injected failure");
      }),
    );
    assert.equal(repo.get("pendingPublication"), null);
    assert.deepEqual(repo.get("provider/a"), {
      account: "opaque-ref",
      digest: "public-digest",
    });
    repo.markEnrollment("request", "pending");
    repo.markEnrollment("consumed", "used");
    repo.close();
    repo = openTeamRepository(f.path);
    assert.equal(repo.enrollment("request"), "cancelled");
    assert.equal(repo.enrollment("consumed"), "used");
    assert.throws(() => repo.markEnrollment("consumed", "pending"));
    repo.close();
    assert(!readFileSync(f.path).includes(Buffer.from("replacement")));
  } finally {
    f.close();
  }
});
test("bounded retained operations reject new data independently per domain and preserve exact stored bytes", () => {
  const f = fixture();
  try {
    const repo = openTeamRepository(f.path);
    for (let i = 0; i < 256; i++)
      repo.addOperation("metadata", i.toString(16).padStart(64, "0"), {
        wire: "encrypted-" + i,
        parents: [],
      });
    repo.addOperation("metadata", "0".repeat(64), {
      wire: "encrypted-0",
      parents: [],
    });
    assert.throws(
      () =>
        repo.addOperation("metadata", "f".repeat(64), {
          wire: "new",
          parents: [],
        }),
      (e) => e instanceof TeamRepositoryFault && e.code === "too-large",
    );
    repo.addOperation("credentials", "f".repeat(64), {
      wire: "separate-budget",
      parents: [],
    });
    assert.throws(() =>
      repo.addOperation("credentials", "f".repeat(64), {
        wire: "substituted",
        parents: [],
      }),
    );
    repo.close();
  } finally {
    f.close();
  }
});
