import { normalizePath, TFile, type Vault } from "obsidian";
import {
  DEFAULT_DENY_RUNTIME_POLICY,
  validateCanonicalSchema,
  type MdbaseRuntimePolicyInfo,
} from "@callumalpass/mdbase-runtime";
import { parseFrontmatter, type MdbaseConfig } from "./mdbaseCore";

export interface RuntimePolicyDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface SelectedRuntimePolicy {
  policy: MdbaseRuntimePolicyInfo;
  path?: string;
  diagnostics: RuntimePolicyDiagnostic[];
}

export async function loadSelectedRuntimePolicy(
  vault: Vault,
  config: MdbaseConfig | null,
): Promise<SelectedRuntimePolicy> {
  if (!config || !config.spec_version.startsWith("0.3.")) return defaultResult();
  if (!config.runtime || config.runtime.enabled === false) return defaultResult();
  if (config.runtime.profile_version !== "0.1.0") {
    return denied("unsupported_profile", `Unsupported runtime profile ${String(config.runtime.profile_version)}.`);
  }
  if (!config.runtime.policy) return defaultResult();

  const selectedPath = normalizePolicyPath(config.runtime.policy);
  if (!selectedPath) {
    return denied("path_traversal", "Runtime policy path must remain inside the vault.", config.runtime.policy);
  }

  const file = vault.getAbstractFileByPath(selectedPath);
  if (!(file instanceof TFile)) {
    return denied("policy_not_selected", `Selected runtime policy was not found: ${selectedPath}.`, selectedPath);
  }

  const parsed = parseFrontmatter(await vault.cachedRead(file));
  if (!parsed.hasFrontmatter || parsed.error) {
    return denied(
      "invalid_runtime_policy",
      parsed.error ?? "Runtime policy must be a Markdown record with frontmatter.",
      selectedPath,
    );
  }

  const validation = validateCanonicalSchema("runtimePolicy", parsed.frontmatter);
  if (!validation.valid) {
    const detail = validation.errors
      .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
      .join("; ");
    return denied("invalid_runtime_policy", `Runtime policy failed canonical validation: ${detail}`, selectedPath);
  }
  if (parsed.frontmatter.enabled === false) {
    return denied("policy_not_selected", `Selected runtime policy is disabled: ${selectedPath}.`, selectedPath);
  }

  const capabilities: Record<string, "allow" | "deny"> = {};
  const rawCapabilities = asRecord(parsed.frontmatter.capabilities);
  for (const [id, value] of Object.entries(rawCapabilities)) {
    const mode = asRecord(value).mode;
    capabilities[id] = mode === "allow" ? "allow" : "deny";
  }

  return {
    policy: {
      id: String(parsed.frontmatter.id),
      selected: true,
      capabilities,
    },
    path: selectedPath,
    diagnostics: [],
  };
}

function normalizePolicyPath(value: string): string | null {
  const slashPath = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!slashPath || slashPath.startsWith("/") || slashPath.split("/").includes("..")) return null;
  const normalized = normalizePath(slashPath);
  return normalized.endsWith(".md") ? normalized : null;
}

function defaultResult(): SelectedRuntimePolicy {
  return { policy: cloneDefaultPolicy(), diagnostics: [] };
}

function denied(code: string, message: string, path?: string): SelectedRuntimePolicy {
  return {
    policy: cloneDefaultPolicy(),
    diagnostics: [{ code, message, path }],
  };
}

function cloneDefaultPolicy(): MdbaseRuntimePolicyInfo {
  return {
    ...DEFAULT_DENY_RUNTIME_POLICY,
    capabilities: { ...DEFAULT_DENY_RUNTIME_POLICY.capabilities },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
