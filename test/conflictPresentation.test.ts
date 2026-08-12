import * as assert from "node:assert/strict";
import { test } from "node:test";
import { boundedLineDiff } from "../src/conflictPresentation";

test("bounded conflict diff labels unchanged, local-only, and remote-only lines", () => {
  const result = boundedLineDiff("one\nlocal\nthree", "one\nremote\nthree");
  assert.deepEqual(result.lines, [
    { kind: "same", value: "one" },
    { kind: "local", value: "local" },
    { kind: "remote", value: "remote" },
    { kind: "same", value: "three" },
  ]);
  assert.equal(result.truncated, false);
});

test("bounded conflict diff caps adversarial documents", () => {
  const result = boundedLineDiff(
    Array.from({ length: 500 }, (_, index) => `local-${index}`).join("\n"),
    Array.from({ length: 500 }, (_, index) => `remote-${index}`).join("\n"),
  );
  assert.equal(result.truncated, true);
  assert.ok(result.lines.length <= 300);
});
