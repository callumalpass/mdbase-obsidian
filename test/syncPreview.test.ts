import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorState } from "@mdbase-dev/connect-sync/mirror";
import {
  localChangeEntries,
  localFileChangeEntries,
  flagConcurrentFileChanges,
  remoteChangeEntries,
  remoteFileChangeEntries,
  summarizePreview,
} from "../src/syncPreview";

function state(): MirrorState {
  return {
    protocol_version: 1,
    replica_id: "replica",
    scope_epoch: 1,
    cursor: 4,
    mode: "read_write",
    records: {
      one: { path: "one.md", revision: "r1", hash: "same" },
      two: { path: "old-two.md", revision: "r2", hash: "old" },
    },
  };
}

test("sync preview reduces remote events to their final visible action", () => {
  const entries = remoteChangeEntries(state(), [
    { sequence: 5, type: "put", record: { record_id: "two", path: "two.md", revision: "r3", frontmatter: {}, body: "", types: [] } },
    { sequence: 6, type: "put", record: { record_id: "new", path: "new.md", revision: "r1", frontmatter: {}, body: "", types: [] } },
    { sequence: 7, type: "remove", record_id: "one", previous_path: "one.md", revision: "r2" },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.action]), [
    ["new.md", "create"],
    ["one.md", "delete"],
    ["two.md", "rename"],
  ]);
});

test("sync preview hides accepted changes that are only waiting for cursor replay", () => {
  const mirrorState = state();
  const entries = remoteChangeEntries(mirrorState, [
    { sequence: 5, type: "put", record: { record_id: "one", path: "one.md", revision: "r1", frontmatter: {}, body: "", types: [] } },
    { sequence: 6, type: "remove", record_id: "already-removed", previous_path: "gone.md", revision: "r2" },
  ]);
  assert.deepEqual(entries, []);
});

test("sync preview finds changed, deleted, new, and queued local documents", () => {
  const mirrorState = state();
  mirrorState.pending = [{
    mutation: {
      mutation_id: "m1",
      replica_id: "replica",
      scope_epoch: 1,
      operation: "update",
      record_id: "queued",
      input: {},
      created_at: "2026-08-05T00:00:00.000Z",
    },
    local_path: "queued.md",
    local_hash: "queued",
  }];
  const entries = localChangeEntries(
    mirrorState,
    new Map([["one.md", null], ["old-two.md", "changed"]]),
    ["new-local.md", "one.md", "old-two.md"],
    new Set(),
    (value) => value === "changed" ? "new" : value,
  );
  assert.deepEqual(entries.map((entry) => [entry.path, entry.action]), [
    ["new-local.md", "create"],
    ["old-two.md", "update"],
    ["one.md", "delete"],
    ["queued.md", "update"],
  ]);
  const preview = summarizePreview({
    already_initialized: true,
    unchanged_documents: 0,
    unchanged_files: 0,
    collisions: [],
    local_issues: [],
    phase: "incremental",
    entries,
    cursor: 4,
    remoteHead: 4,
  });
  assert.equal(preview.upload_documents, 4);
  assert.equal(preview.download_documents, 0);
});

test("sync preview distinguishes hosted and local binary file transfers", () => {
  const mirrorState = state();
  mirrorState.files = {
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": {
      file: {
        file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        path: "Media/old.png",
        revision: "file:old",
        content_digest: `sha256:${"1".repeat(64)}`,
        size: 3,
        media_class: "image",
        modified_at: "2026-08-05T00:00:00.000Z",
      },
    },
  };
  const hostedFile = {
    ...mirrorState.files["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"].file,
    path: "Media/new.png",
    revision: "file:new",
  };
  const remote = remoteFileChangeEntries(mirrorState, [{
    sequence: 5,
    type: "file_put",
    file: hostedFile,
  }], () => true);
  const local = localFileChangeEntries(
    mirrorState,
    new Map([
      ["Media/old.png", { size: 4, content_digest: `sha256:${"2".repeat(64)}` as const }],
      ["Media/local.pdf", { size: 9, content_digest: `sha256:${"3".repeat(64)}` as const }],
    ]),
    ["Media/old.png", "Media/local.pdf"],
  );
  assert.deepEqual(remote.map((entry) => [entry.kind, entry.path, entry.action]), [
    ["file", "Media/new.png", "rename"],
  ]);
  assert.deepEqual(local.map((entry) => [entry.kind, entry.path, entry.action]), [
    ["file", "Media/local.pdf", "create"],
    ["file", "Media/old.png", "update"],
  ]);
  const preview = summarizePreview({
    already_initialized: true,
    unchanged_documents: 0,
    unchanged_files: 0,
    collisions: [],
    local_issues: [],
    phase: "incremental",
    entries: [...remote, ...local],
    cursor: 4,
    remoteHead: 5,
  });
  assert.equal(preview.download_files, 1);
  assert.equal(preview.upload_files, 2);
  assert.equal(preview.download_documents, 0);
  assert.equal(preview.upload_documents, 0);
});

test("sync preview turns concurrent local and hosted file edits into one decision", () => {
  const entries = flagConcurrentFileChanges([
    {
      kind: "file",
      path: "Media/new.png",
      direction: "download",
      action: "rename",
      detail: "Hosted rename.",
      fileId: "same-file",
    },
    {
      kind: "file",
      path: "Media/old.png",
      direction: "upload",
      action: "update",
      detail: "Local update.",
      fileId: "same-file",
    },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.direction, entry.action, entry.fileId]), [
    ["attention", "fix", "same-file"],
  ]);
  assert.match(entries[0].detail, /both the local and hosted file changed/i);
});
