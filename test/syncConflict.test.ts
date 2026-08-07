import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import { resolveConflictAndRefresh } from "../src/syncConflict";
import type { MdbaseSyncPreview } from "../src/syncPreview";

test("conflict resolution returns only a fresh post-decision plan", async () => {
  const calls: string[] = [];
  const status = { state: "changes_waiting" } as MirrorStatus;
  const preview = {
    plan: { fingerprint: "sha256:fresh" },
  } as MdbaseSyncPreview;
  const controller = {
    resolveConflict: async (
      objectId: string,
      decisionId: string,
      resolution: "local" | "remote",
    ) => {
      calls.push(`resolve:${objectId}:${decisionId}:${resolution}`);
      return status;
    },
    preview: async () => {
      calls.push("preview");
      return preview;
    },
  };

  assert.deepEqual(
    await resolveConflictAndRefresh(controller as never, "record-1", "sha256:decision", "remote"),
    { status, preview },
  );
  assert.deepEqual(calls, [
    "resolve:record-1:sha256:decision:remote",
    "preview",
  ]);
});

test("a rejected conflict decision never produces a replacement preview", async () => {
  let previewed = false;
  const controller = {
    resolveConflict: async () => {
      throw new Error("mirror_conflict_stale");
    },
    preview: async () => {
      previewed = true;
      throw new Error("unreachable");
    },
  };

  await assert.rejects(
    resolveConflictAndRefresh(controller as never, "record-1", "sha256:stale", "local"),
    /mirror_conflict_stale/,
  );
  assert.equal(previewed, false);
});
