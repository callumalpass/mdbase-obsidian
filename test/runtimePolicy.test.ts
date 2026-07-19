import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TFile, normalizePath } from "obsidian";
import type { MdbaseConfig } from "../src/mdbaseCore";
import { loadSelectedRuntimePolicy } from "../src/runtimePolicy";

const TestFileCtor = TFile as unknown as { new (path: string): TFile };

class MockVault {
  private files = new Map<string, { file: TFile; content: string }>();

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(normalizePath(path))?.file ?? null;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? "";
  }

  write(path: string, content: string): void {
    const normalized = normalizePath(path);
    this.files.set(normalized, { file: new TestFileCtor(normalized), content });
  }
}

function config(policy?: string): MdbaseConfig {
  return {
    spec_version: "0.3.0",
    runtime: {
      profile_version: "0.1.0",
      policy,
    },
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: [],
    },
  };
}

test("loads and normalizes the selected canonical runtime policy", async () => {
  const vault = new MockVault();
  vault.write("policies/local.md", `---
${JSON.stringify({
  type: "runtime_policy",
  id: "local.runtime",
  version: 1,
  name: "Local runtime policy",
  capabilities: {
    "task.patch": { mode: "allow" },
    "task.read": {},
  },
})}
---
`);

  const result = await loadSelectedRuntimePolicy(vault as never, config("policies/local.md"));

  assert.equal(result.policy.id, "local.runtime");
  assert.deepEqual(result.policy.capabilities, {
    "task.patch": "allow",
    "task.read": "deny",
  });
  assert.equal(result.path, "policies/local.md");
  assert.deepEqual(result.diagnostics, []);
});

test("missing or invalid selected policies remain default-deny", async () => {
  const vault = new MockVault();
  vault.write("policies/invalid.md", `---
${JSON.stringify({
  type: "runtime_policy",
  id: "invalid",
  version: 1,
  name: "Invalid",
  typo: true,
})}
---
`);

  const missing = await loadSelectedRuntimePolicy(vault as never, config("policies/missing.md"));
  const invalid = await loadSelectedRuntimePolicy(vault as never, config("policies/invalid.md"));
  const traversal = await loadSelectedRuntimePolicy(vault as never, config("../outside.md"));

  assert.equal(missing.policy.id, "mdbase.default-deny");
  assert.equal(missing.diagnostics[0]?.code, "policy_not_selected");
  assert.equal(invalid.policy.id, "mdbase.default-deny");
  assert.equal(invalid.diagnostics[0]?.code, "invalid_runtime_policy");
  assert.equal(traversal.policy.id, "mdbase.default-deny");
  assert.equal(traversal.diagnostics[0]?.code, "path_traversal");
});
