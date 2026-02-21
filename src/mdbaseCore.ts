import { normalizePath, parseYaml, stringifyYaml, TFile, Vault } from "obsidian";
import picomatch from "picomatch";

export type IssueSeverity = "error" | "warn";

export interface MdbaseIssue {
  path: string;
  code: string;
  message: string;
  severity: IssueSeverity;
  field?: string;
}

export interface MdbaseSettings {
  types_folder: string;
  explicit_type_keys: string[];
  default_strict: boolean;
  include_subfolders: boolean;
  exclude: string[];
}

export interface MdbaseConfig {
  spec_version: string;
  name?: string;
  description?: string;
  settings: MdbaseSettings;
}

export interface MdbaseFieldDef {
  type?: string;
  required?: boolean;
  default?: unknown;
  computed?: string;
  values?: unknown[];
  items?: MdbaseFieldDef;
  fields?: Record<string, MdbaseFieldDef>;
}

export interface MdbaseTypeDef {
  name: string;
  display_name_key?: string;
  path_pattern?: string;
  strict?: boolean;
  match?: {
    path_glob?: string;
    fields_present?: string[];
    where?: Record<string, unknown> | string;
  };
  fields: Record<string, MdbaseFieldDef>;
  filePath: string;
}

interface FrontmatterParse {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  error?: string;
}

const DEFAULT_CONFIG: MdbaseConfig = {
  spec_version: "0.2.1",
  name: "My mdbase collection",
  description: "Typed markdown collection",
  settings: {
    types_folder: "_types",
    explicit_type_keys: ["type", "types"],
    default_strict: false,
    include_subfolders: true,
    exclude: ["_types", ".obsidian", ".git", "node_modules", ".trash", ".mdbase"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function parseFrontmatter(content: string): FrontmatterParse {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      body: content,
    };
  }

  try {
    const parsed = parseYaml(frontmatterMatch[1]);
    if (parsed != null && !isRecord(parsed)) {
      return {
        hasFrontmatter: true,
        frontmatter: {},
        body: content.slice(frontmatterMatch[0].length),
        error: "Frontmatter must be a YAML object",
      };
    }

    return {
      hasFrontmatter: true,
      frontmatter: (parsed as Record<string, unknown>) ?? {},
      body: content.slice(frontmatterMatch[0].length),
    };
  } catch (error) {
    return {
      hasFrontmatter: true,
      frontmatter: {},
      body: content.slice(frontmatterMatch[0].length),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatMarkdown(frontmatter: Record<string, unknown>, body = ""): string {
  const yaml = stringifyYaml(frontmatter).trimEnd();
  const normalizedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}

export async function loadMdbaseConfig(vault: Vault): Promise<MdbaseConfig | null> {
  const configFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(configFile instanceof TFile)) {
    return null;
  }

  try {
    const raw = await vault.cachedRead(configFile);
    const parsed = parseYaml(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const settings = isRecord(parsed.settings) ? parsed.settings : {};

    return {
      spec_version: typeof parsed.spec_version === "string" ? parsed.spec_version : DEFAULT_CONFIG.spec_version,
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_CONFIG.name,
      description: typeof parsed.description === "string" ? parsed.description : DEFAULT_CONFIG.description,
      settings: {
        types_folder:
          typeof settings.types_folder === "string"
            ? settings.types_folder
            : DEFAULT_CONFIG.settings.types_folder,
        explicit_type_keys: Array.isArray(settings.explicit_type_keys)
          ? settings.explicit_type_keys.filter((value): value is string => typeof value === "string")
          : [...DEFAULT_CONFIG.settings.explicit_type_keys],
        default_strict:
          typeof settings.default_strict === "boolean"
            ? settings.default_strict
            : DEFAULT_CONFIG.settings.default_strict,
        include_subfolders:
          typeof settings.include_subfolders === "boolean"
            ? settings.include_subfolders
            : DEFAULT_CONFIG.settings.include_subfolders,
        exclude: Array.isArray(settings.exclude)
          ? settings.exclude.filter((value): value is string => typeof value === "string")
          : [...DEFAULT_CONFIG.settings.exclude],
      },
    };
  } catch {
    return null;
  }
}

export async function ensureCollectionInitialized(vault: Vault): Promise<{ created: string[] }> {
  const created: string[] = [];

  const mdbaseFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(mdbaseFile instanceof TFile)) {
    const configYaml = stringifyYaml(DEFAULT_CONFIG).trimEnd() + "\n";
    await vault.create("mdbase.yaml", configYaml);
    created.push("mdbase.yaml");
  }

  const config = (await loadMdbaseConfig(vault)) ?? DEFAULT_CONFIG;
  const typesFolder = config.settings.types_folder;

  const typesFolderExists = await vault.adapter.exists(typesFolder);
  if (!typesFolderExists) {
    await vault.createFolder(typesFolder);
    created.push(typesFolder);
  }

  const noteTypePath = normalizePath(`${typesFolder}/note.md`);
  const noteTypeExists = await vault.adapter.exists(noteTypePath);
  if (!noteTypeExists) {
    const typeFrontmatter = {
      name: "note",
      description: "Base note type",
      strict: false,
      fields: {
        title: {
          type: "string",
          required: true,
        },
        tags: {
          type: "list",
          items: { type: "string" },
        },
      },
    };

    const content = `${formatMarkdown(typeFrontmatter, "# Note\n\nDefault note type.")}\n`;
    await vault.create(noteTypePath, content);
    created.push(noteTypePath);
  }

  return { created };
}

export async function loadTypeDefinitions(vault: Vault, config: MdbaseConfig): Promise<Map<string, MdbaseTypeDef>> {
  const typeMap = new Map<string, MdbaseTypeDef>();
  const typesFolderPrefix = `${normalizePath(config.settings.types_folder)}/`;

  for (const file of vault.getMarkdownFiles()) {
    if (!file.path.startsWith(typesFolderPrefix)) continue;

    const content = await vault.cachedRead(file);
    const parsed = parseFrontmatter(content);
    if (!parsed.hasFrontmatter || parsed.error) continue;

    const fm = parsed.frontmatter;
    if (!isRecord(fm.fields)) continue;

    const name = typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : file.basename;
    const fields: Record<string, MdbaseFieldDef> = {};

    for (const [fieldName, value] of Object.entries(fm.fields)) {
      if (isRecord(value)) {
        fields[fieldName] = value as MdbaseFieldDef;
      }
    }

    const typeDef: MdbaseTypeDef = {
      name,
      display_name_key: typeof fm.display_name_key === "string" ? fm.display_name_key : undefined,
      path_pattern: typeof fm.path_pattern === "string" ? fm.path_pattern : undefined,
      strict: typeof fm.strict === "boolean" ? fm.strict : undefined,
      match: isRecord(fm.match) ? (fm.match as MdbaseTypeDef["match"]) : undefined,
      fields,
      filePath: file.path,
    };

    typeMap.set(typeDef.name, typeDef);
  }

  return typeMap;
}

function getExplicitTypes(
  frontmatter: Record<string, unknown>,
  explicitTypeKeys: string[],
): string[] | null {
  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      const typeNames = value.filter((entry): entry is string => typeof entry === "string");
      return typeNames;
    }
  }

  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
  }

  return null;
}

function applyPathTemplate(template: string, frontmatter: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = frontmatter[key];
    if (value == null) return "";
    if (Array.isArray(value)) return value.join("-");
    return String(value);
  });
}

function extractBaseFolderFromGlob(globPattern: string): string {
  const wildcardIndex = globPattern.search(/[\*\?\[]/);
  const prefix = wildcardIndex === -1 ? globPattern : globPattern.slice(0, wildcardIndex);
  const folder = prefix.replace(/\/+$/, "");
  if (folder.endsWith(".md")) {
    const slashIndex = folder.lastIndexOf("/");
    return slashIndex >= 0 ? folder.slice(0, slashIndex) : "";
  }
  return folder;
}

export function resolveFolderForType(typeDef: MdbaseTypeDef, frontmatter: Record<string, unknown>): string {
  if (typeDef.path_pattern) {
    const templated = normalizePath(applyPathTemplate(typeDef.path_pattern, frontmatter));
    if (templated.endsWith(".md")) {
      const slashIndex = templated.lastIndexOf("/");
      return slashIndex >= 0 ? templated.slice(0, slashIndex) : "";
    }
    return templated.replace(/\/+$/, "");
  }

  if (typeDef.match?.path_glob) {
    return extractBaseFolderFromGlob(typeDef.match.path_glob);
  }

  return "";
}

function matchesSimpleWhere(where: Record<string, unknown>, frontmatter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(where)) {
    if (frontmatter[field] !== expected) return false;
  }
  return true;
}

export function getTypesForFile(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): string[] {
  const explicit = getExplicitTypes(frontmatter, config.settings.explicit_type_keys);
  if (explicit) return explicit;

  const matched: string[] = [];
  for (const [typeName, typeDef] of types.entries()) {
    const match = typeDef.match;
    if (!match) continue;

    let isMatch = true;

    if (typeof match.path_glob === "string") {
      const matcher = picomatch(match.path_glob, { dot: true });
      if (!matcher(relativePath)) isMatch = false;
    }

    if (isMatch && Array.isArray(match.fields_present)) {
      for (const key of match.fields_present) {
        if (!(key in frontmatter)) {
          isMatch = false;
          break;
        }
      }
    }

    if (isMatch && isRecord(match.where)) {
      isMatch = matchesSimpleWhere(match.where, frontmatter);
    }

    if (isMatch && typeof match.where === "string") {
      // String where expressions are intentionally skipped in MVP.
      isMatch = false;
    }

    if (isMatch) matched.push(typeName);
  }

  return matched;
}

function isMissingRequired(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTimeString(value: string): boolean {
  return /^\d{2}:\d{2}(:\d{2})?$/.test(value);
}

function validateFieldValue(
  value: unknown,
  fieldDef: MdbaseFieldDef,
  fieldPath: string,
  filePath: string,
  issues: MdbaseIssue[],
): void {
  const typeName = fieldDef.type ?? "any";

  if (value === undefined || value === null) return;

  const pushTypeIssue = (expected: string) => {
    issues.push({
      path: filePath,
      code: "invalid_type",
      field: fieldPath,
      severity: "error",
      message: `Field '${fieldPath}' expected ${expected}`,
    });
  };

  switch (typeName) {
    case "any":
      return;
    case "string":
      if (typeof value !== "string") pushTypeIssue("a string");
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) pushTypeIssue("an integer");
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) pushTypeIssue("a number");
      return;
    case "boolean":
      if (typeof value !== "boolean") pushTypeIssue("a boolean");
      return;
    case "date":
      if (typeof value !== "string" || !isDateString(value)) pushTypeIssue("a date (YYYY-MM-DD)");
      return;
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        pushTypeIssue("a datetime string");
      }
      return;
    case "time":
      if (typeof value !== "string" || !isTimeString(value)) pushTypeIssue("a time string (HH:MM)");
      return;
    case "enum": {
      const values = Array.isArray(fieldDef.values) ? fieldDef.values : [];
      if (!values.includes(value)) {
        issues.push({
          path: filePath,
          code: "invalid_enum",
          field: fieldPath,
          severity: "error",
          message: `Field '${fieldPath}' must be one of: ${values.map((entry) => String(entry)).join(", ")}`,
        });
      }
      return;
    }
    case "list": {
      if (!Array.isArray(value)) {
        pushTypeIssue("a list");
        return;
      }
      if (fieldDef.items) {
        value.forEach((item, index) => {
          validateFieldValue(item, fieldDef.items as MdbaseFieldDef, `${fieldPath}[${index}]`, filePath, issues);
        });
      }
      return;
    }
    case "object": {
      if (!isRecord(value)) {
        pushTypeIssue("an object");
        return;
      }
      if (fieldDef.fields && isRecord(fieldDef.fields)) {
        for (const [nestedName, nestedDef] of Object.entries(fieldDef.fields)) {
          if (!isRecord(nestedDef)) continue;
          validateFieldValue(
            value[nestedName],
            nestedDef as MdbaseFieldDef,
            `${fieldPath}.${nestedName}`,
            filePath,
            issues,
          );
        }
      }
      return;
    }
    case "link":
      if (typeof value !== "string" && !isRecord(value)) pushTypeIssue("a link string");
      return;
    case "tags":
      if (typeof value === "string") return;
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return;
      pushTypeIssue("a tag string or list of strings");
      return;
    default:
      return;
  }
}

function validateAgainstType(
  filePath: string,
  frontmatter: Record<string, unknown>,
  typeDef: MdbaseTypeDef,
  issues: MdbaseIssue[],
): void {
  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    const value = frontmatter[fieldName];

    if (fieldDef.required && isMissingRequired(value)) {
      issues.push({
        path: filePath,
        code: "missing_required",
        field: fieldName,
        severity: "error",
        message: `Missing required field '${fieldName}' for type '${typeDef.name}'`,
      });
      continue;
    }

    validateFieldValue(value, fieldDef, fieldName, filePath, issues);
  }
}

function mergedFieldNames(typeDefs: MdbaseTypeDef[]): Set<string> {
  const names = new Set<string>();
  for (const typeDef of typeDefs) {
    for (const key of Object.keys(typeDef.fields)) {
      names.add(key);
    }
  }
  return names;
}

function isExcluded(path: string, config: MdbaseConfig): boolean {
  const typesFolder = normalizePath(config.settings.types_folder);
  if (path.startsWith(`${typesFolder}/`) || path === typesFolder) return true;

  for (const pattern of config.settings.exclude) {
    const matcher = picomatch(pattern, { dot: true, matchBase: !pattern.includes("/") });
    if (matcher(path)) return true;

    if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("/") && path.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  return false;
}

export async function validateFile(
  vault: Vault,
  file: TFile,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
): Promise<MdbaseIssue[]> {
  if (isExcluded(file.path, config)) return [];

  const issues: MdbaseIssue[] = [];
  const raw = await vault.cachedRead(file);
  const parsed = parseFrontmatter(raw);

  if (parsed.error) {
    issues.push({
      path: file.path,
      code: "invalid_frontmatter",
      message: parsed.error,
      severity: "error",
    });
    return issues;
  }

  if (!parsed.hasFrontmatter) {
    issues.push({
      path: file.path,
      code: "missing_frontmatter",
      message: "File has no YAML frontmatter",
      severity: "warn",
    });
  }

  const frontmatter = parsed.frontmatter;
  const typeNames = getTypesForFile(file.path, frontmatter, config, typeMap);

  if (typeNames.length === 0) {
    issues.push({
      path: file.path,
      code: "no_matching_type",
      message: "No type could be resolved for this file",
      severity: "warn",
    });
    return issues;
  }

  const typeDefs = typeNames
    .map((typeName) => typeMap.get(typeName))
    .filter((typeDef): typeDef is MdbaseTypeDef => !!typeDef);

  if (typeDefs.length === 0) {
    issues.push({
      path: file.path,
      code: "unknown_type",
      message: `Resolved types are not defined: ${typeNames.join(", ")}`,
      severity: "error",
    });
    return issues;
  }

  for (const typeDef of typeDefs) {
    validateAgainstType(file.path, frontmatter, typeDef, issues);
  }

  const strict = typeDefs.some((typeDef) => typeDef.strict === true) || config.settings.default_strict;
  if (strict) {
    const known = mergedFieldNames(typeDefs);
    const typeKeys = new Set(config.settings.explicit_type_keys);

    for (const fieldName of Object.keys(frontmatter)) {
      if (known.has(fieldName) || typeKeys.has(fieldName)) continue;
      issues.push({
        path: file.path,
        code: "unknown_field",
        field: fieldName,
        message: `Unknown field '${fieldName}' in strict mode`,
        severity: "warn",
      });
    }
  }

  return issues;
}

export async function validateCollection(
  vault: Vault,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
): Promise<MdbaseIssue[]> {
  const all: MdbaseIssue[] = [];
  for (const file of vault.getMarkdownFiles()) {
    if (isExcluded(file.path, config)) continue;
    const issues = await validateFile(vault, file, config, typeMap);
    all.push(...issues);
  }
  return all;
}

export function buildTypeTemplate(name: string, pathGlob?: string): string {
  const frontmatter: Record<string, unknown> = {
    name,
    description: `${name} type`,
    strict: false,
    fields: {
      title: {
        type: "string",
        required: true,
      },
    },
  };

  if (pathGlob && pathGlob.trim().length > 0) {
    frontmatter.match = {
      path_glob: pathGlob.trim(),
    };
  }

  return `${formatMarkdown(frontmatter, `# ${name}\n\nType definition for ${name}.`)}\n`;
}

export async function createTypeDefinition(
  vault: Vault,
  config: MdbaseConfig,
  typeName: string,
  pathGlob?: string,
): Promise<string> {
  const safeName = typeName.trim();
  const typePath = normalizePath(`${config.settings.types_folder}/${safeName}.md`);

  if (await vault.adapter.exists(typePath)) {
    throw new Error(`Type already exists: ${typePath}`);
  }

  const content = buildTypeTemplate(safeName, pathGlob);
  await vault.create(typePath, content);
  return typePath;
}

export function buildInitialFrontmatter(typeDef: MdbaseTypeDef, config: MdbaseConfig): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  const primaryTypeKey = config.settings.explicit_type_keys[0] ?? "type";
  frontmatter[primaryTypeKey] = primaryTypeKey === "types" ? [typeDef.name] : typeDef.name;

  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    if (fieldDef.default !== undefined) {
      frontmatter[fieldName] = deepClone(fieldDef.default);
    }
  }

  return frontmatter;
}

export function getPromptFields(typeDef: MdbaseTypeDef, currentFrontmatter: Record<string, unknown>): Array<[string, MdbaseFieldDef]> {
  const fields: Array<[string, MdbaseFieldDef]> = [];

  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    if (fieldDef.computed) continue;
    if (!fieldDef.required) continue;
    if (currentFrontmatter[fieldName] !== undefined) continue;
    fields.push([fieldName, fieldDef]);
  }

  return fields;
}

export function coerceFieldInput(rawInput: string, fieldDef: MdbaseFieldDef): unknown {
  const trimmed = rawInput.trim();
  const typeName = fieldDef.type ?? "string";

  switch (typeName) {
    case "string":
    case "date":
    case "datetime":
    case "time":
    case "link":
    case "enum":
    case "any":
      return trimmed;
    case "integer": {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(parsed)) throw new Error("Expected integer input");
      return parsed;
    }
    case "number": {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isNaN(parsed)) throw new Error("Expected numeric input");
      return parsed;
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lowered)) return true;
      if (["false", "0", "no", "n"].includes(lowered)) return false;
      throw new Error("Expected boolean input: true/false");
    }
    case "list": {
      const values = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (!fieldDef.items) return values;
      return values.map((entry) => coerceFieldInput(entry, fieldDef.items as MdbaseFieldDef));
    }
    case "object": {
      const parsed = parseYaml(trimmed);
      if (!isRecord(parsed)) {
        throw new Error("Expected YAML object value");
      }
      return parsed;
    }
    case "tags":
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    default:
      return trimmed;
  }
}

export function slugify(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return value.length > 0 ? value : "note";
}

async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath).replace(/\/+$/, "");
  if (!normalized) return;

  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.adapter.exists(current))) {
      await vault.createFolder(current);
    }
  }
}

export async function buildUniqueNotePath(
  vault: Vault,
  typeDef: MdbaseTypeDef,
  frontmatter: Record<string, unknown>,
): Promise<string> {
  const displayFieldName = typeDef.display_name_key ?? "title";
  const displayValue = frontmatter[displayFieldName];

  const fallback = `${typeDef.name}-${new Date().toISOString().slice(0, 10)}`;
  const source = typeof displayValue === "string" && displayValue.trim().length > 0 ? displayValue : fallback;
  const slug = slugify(source);

  const folder = resolveFolderForType(typeDef, frontmatter);
  const basePath = normalizePath(`${folder ? `${folder}/` : ""}${slug}.md`);

  let candidate = basePath;
  let index = 2;
  while (vault.getAbstractFileByPath(candidate)) {
    candidate = basePath.replace(/\.md$/, `-${index}.md`);
    index += 1;
  }

  const slashIndex = candidate.lastIndexOf("/");
  if (slashIndex > 0) {
    await ensureFolderExists(vault, candidate.slice(0, slashIndex));
  }

  return candidate;
}

export async function createNoteFromType(
  vault: Vault,
  path: string,
  frontmatter: Record<string, unknown>,
  body = "",
): Promise<TFile> {
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex > 0) {
    await ensureFolderExists(vault, normalized.slice(0, slashIndex));
  }

  if (await vault.adapter.exists(normalized)) {
    throw new Error(`File already exists: ${normalized}`);
  }

  const content = `${formatMarkdown(frontmatter, body)}\n`;
  return vault.create(normalized, content);
}
