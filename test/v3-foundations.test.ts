import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { normalizePath, TFile, TFolder } from "obsidian";
import { MemoryAuthority } from "@mdbase-dev/connect-sync";
import {
  DirectoryMirror,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
} from "@mdbase-dev/connect-sync/mirror";
import {
  ConnectSyncController,
  DeviceMirrorLease,
  ObsidianMirrorFileSystem,
} from "../src/connectSync";
import { MirrorEnrollmentClient } from "@mdbase-dev/connect-sync/enrollment";
import {
  analyzeV02Migration,
  applyV02Migration,
} from "../src/migration";
import {
  frontmatterFromTypeModel,
  typeModelFromDocument,
  validateMdbaseTypeName,
} from "../src/typeModel";
import {
  getTypesForFile,
  schemaFromV03Fields,
  type MdbaseConfig,
  type MdbaseTypeDef,
  parseFrontmatter,
} from "../src/mdbaseCore";

interface StoredFile {
  file: TFile;
  content: string;
  binary?: ArrayBuffer;
}

const TestFile = TFile as unknown as { new (path: string): TFile };
const TestFolder = TFolder as unknown as { new (path: string): TFolder };

function sha256Revision(document: string): string {
  return `sha256:${createHash("sha256").update(document).digest("hex")}`;
}

class MemoryVault {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Map<string, TFolder>();
  failTargetPath: string | null = null;
  failCreatePath: string | null = null;
  corruptTargetPath: string | null = null;
  targetWrites = 0;

  adapter = {
    exists: async (path: string): Promise<boolean> => {
      const normalized = normalizePath(path);
      return this.files.has(normalized) || this.folders.has(normalized);
    },
    read: async (path: string): Promise<string> => {
      const entry = this.files.get(normalizePath(path));
      if (!entry) throw new Error(`missing ${path}`);
      return entry.content;
    },
    write: async (path: string, content: string): Promise<void> => {
      const normalized = normalizePath(path);
      const existing = this.files.get(normalized)?.file ?? new TestFile(normalized);
      this.files.set(normalized, { file: existing, content });
    },
    remove: async (path: string): Promise<void> => {
      this.files.delete(normalizePath(path));
    },
  };

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file ?? this.folders.get(normalized) ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].map((entry) => entry.file).filter((file) => file.extension === "md");
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map((entry) => entry.file);
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.content;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (normalized === this.failCreatePath) throw new Error("injected adapter create failure");
    if (this.files.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    if (
      file.path === this.failTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.targetWrites += 1;
      throw new Error("injected migration target write failure");
    }
    if (
      file.path === this.corruptTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.files.set(file.path, { file, content: `${content}# injected corruption\n` });
      return;
    }
    this.files.set(file.path, { file, content });
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.binary?.slice(0) ?? new TextEncoder().encode(entry.content).buffer;
  }

  async createBinary(path: string, value: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.files.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.files.set(normalized, { file, content: "", binary: value.slice(0) });
    return file;
  }

  async modifyBinary(file: TFile, value: ArrayBuffer): Promise<void> {
    this.files.set(file.path, { file, content: "", binary: value.slice(0) });
  }

  async createFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!this.folders.has(normalized)) this.folders.set(normalized, new TestFolder(normalized));
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }

  read(path: string): string | null {
    return this.files.get(normalizePath(path))?.content ?? null;
  }
}

class LaggyFolderMetadataVault extends MemoryVault {
  override getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    if (this.folders.has(normalized)) return null;
    return this.files.get(normalized)?.file ?? null;
  }
}

function v02Config(): string {
  return `${JSON.stringify({
    spec_version: "0.2.0",
    name: "TaskNotes",
    settings: {
      types_folder: "_types",
      default_strict: false,
      exclude: ["_types"],
    },
  }, null, 2)}\n`;
}

function typeDocument(frontmatter: Record<string, unknown>, body = "# Type"): string {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${body}\n`;
}

function taskType(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "task",
    description: "Task type",
    display_name_key: "title",
    strict: false,
    match: { where: { tags: { contains: "task" } } },
    fields: {
      title: { type: "string", required: true, tn_role: "title" },
      tags: { type: "list", items: { type: "string" }, tn_role: "tags" },
      status: {
        type: "enum",
        values: ["open", "done"],
        default: "open",
        tn_role: "status",
        tn_completed_values: ["done"],
      },
      dateCreated: { type: "datetime", generated: "now", tn_role: "dateCreated" },
      projects: { type: "list", items: { type: "link", target: "project" } },
    },
    ...overrides,
  };
}

async function collectionVault(
  type = taskType(),
  vault: MemoryVault = new MemoryVault(),
): Promise<MemoryVault> {
  await vault.create("mdbase.yaml", v02Config());
  await vault.createFolder("_types");
  await vault.create("_types/task.md", typeDocument(type, "# Task"));
  await vault.create("records/unchanged.md", typeDocument({ tags: ["task"], title: "Keep me" }, "Record body"));
  await vault.create("records/body-only.md", "# Plain Markdown\n");
  return vault;
}

test("v0.2 TaskNotes contains match works before migration", () => {
  const config: MdbaseConfig = {
    spec_version: "0.2.0",
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: ["_types"],
    },
  };
  const types = new Map<string, MdbaseTypeDef>([
    ["task", {
      name: "task",
      fields: {},
      filePath: "_types/task.md",
      match: { where: { tags: { contains: "task" } } },
    }],
  ]);
  assert.deepEqual(getTypesForFile("a.md", { tags: ["inbox", "task"] }, config, types), ["task"]);
  assert.deepEqual(getTypesForFile("a.md", { tags: ["inbox"] }, config, types), []);
});

test("migration analysis converts TaskNotes semantics and never proposes record rewrites", async () => {
  const vault = await collectionVault();
  const recordBefore = vault.read("records/unchanged.md");
  const plan = await analyzeV02Migration(vault as never);
  assert.equal(plan.sourceVersion, "0.2.0");
  assert.equal(plan.targetVersion, "0.3.0");
  assert.equal(plan.recordFilesRewritten, 0);
  assert.equal(plan.recordsVerified, 2);
  assert.equal(plan.recordsSkipped, 0);
  assert.deepEqual(plan.operations.map((entry) => entry.path), ["mdbase.yaml", "_types/task.md"]);
  assert.equal(plan.typeSummaries[0].taskNotes, true);
  assert.deepEqual(plan.typeSummaries[0].defaultsMoved, ["status"]);
  assert.deepEqual(plan.typeSummaries[0].generatedFieldsMoved, ["dateCreated"]);
  assert.deepEqual(plan.typeSummaries[0].linksMoved, ["projects[]"]);
  const migrated = parseFrontmatter(plan.operations[1].target).frontmatter;
  assert.equal(migrated.kind, "mdbase.type");
  assert.deepEqual((migrated.match as Record<string, unknown>).where, { tags: { contains: "task" } });
  assert.ok(isObject(migrated["x-tasknotes"]));
  assert.equal(vault.read("records/unchanged.md"), recordBefore);
  assert.equal(vault.read("records/body-only.md"), "# Plain Markdown\n");
});

test("migration applies from verified inputs, writes recovery backups, and leaves records byte-identical", async () => {
  const vault = await collectionVault();
  const recordBefore = vault.read("records/unchanged.md");
  const bodyOnlyBefore = vault.read("records/body-only.md");
  const plan = await analyzeV02Migration(vault as never);
  const result = await applyV02Migration(vault as never, plan);
  assert.equal(result.applied, true);
  assert.match(vault.read("mdbase.yaml") ?? "", /"spec_version": "0.3.0"/);
  assert.match(vault.read("_types/task.md") ?? "", /kind(?:"|):\s*"?(?:mdbase\.type)/);
  assert.equal(vault.read("records/unchanged.md"), recordBefore);
  assert.equal(vault.read("records/body-only.md"), bodyOnlyBefore);
  assert.equal(vault.read(`${plan.backupLocation}/files/mdbase.yaml`), plan.operations[0].source);
  const manifest = JSON.parse(vault.read(result.manifestPath) ?? "{}") as { status?: string; written?: string[] };
  assert.equal(manifest.status, "applied");
  assert.deepEqual(manifest.written, ["mdbase.yaml", "_types/task.md"]);
});

test("migration refuses stale analysis and rolls back injected mid-apply failures", async () => {
  const staleVault = await collectionVault();
  const stalePlan = await analyzeV02Migration(staleVault as never);
  const configFile = staleVault.getAbstractFileByPath("mdbase.yaml") as TFile;
  await staleVault.modify(configFile, `${v02Config()}# external edit\n`);
  await assert.rejects(
    applyV02Migration(staleVault as never, stalePlan),
    /changed after migration analysis/,
  );

  const failingVault = await collectionVault();
  const plan = await analyzeV02Migration(failingVault as never);
  failingVault.failTargetPath = "_types/task.md";
  const result = await applyV02Migration(failingVault as never, plan);
  assert.equal(result.applied, false);
  assert.equal(result.restored, true);
  assert.equal(failingVault.read("mdbase.yaml"), plan.operations[0].source);
  assert.equal(failingVault.read("_types/task.md"), plan.operations[1].source);
  const manifest = JSON.parse(failingVault.read(result.manifestPath) ?? "{}") as { status?: string };
  assert.equal(manifest.status, "rolled_back");

  const corruptingVault = await collectionVault();
  const corruptingPlan = await analyzeV02Migration(corruptingVault as never);
  corruptingVault.corruptTargetPath = "_types/task.md";
  const corruptingResult = await applyV02Migration(corruptingVault as never, corruptingPlan);
  assert.equal(corruptingResult.applied, false);
  assert.equal(corruptingResult.restored, true);
  assert.equal(corruptingVault.read("mdbase.yaml"), corruptingPlan.operations[0].source);
  assert.equal(corruptingVault.read("_types/task.md"), corruptingPlan.operations[1].source);
});

test("migration and mirror tolerate Obsidian folder metadata cache lag", async () => {
  const vault = await collectionVault(taskType(), new LaggyFolderMetadataVault());
  const plan = await analyzeV02Migration(vault as never);
  const result = await applyV02Migration(vault as never, plan);
  assert.equal(result.applied, true);
  assert.equal(JSON.parse(vault.read(result.manifestPath) ?? "{}").status, "applied");

  const mirrorVault = new LaggyFolderMetadataVault();
  const fileSystem = new ObsidianMirrorFileSystem(mirrorVault as never);
  await fileSystem.write("deeply/nested/mobile/note.md", "content");
  assert.equal(await fileSystem.read("deeply/nested/mobile/note.md"), "content");
});

test("lossy v0.2 migrations require explicit reviewed consent", async () => {
  const vault = await collectionVault(taskType({
    extends: "base",
    fields: {
      title: { type: "string", computed: "record.name" },
    },
  }));
  const plan = await analyzeV02Migration(vault as never);
  assert.equal(plan.applicable, false);
  assert.ok(plan.diagnostics.some((entry) => entry.severity === "lossy"));
  await assert.rejects(applyV02Migration(vault as never, plan), /explicitly allow lossy/);
  const applied = await applyV02Migration(vault as never, plan, { allowLossy: true });
  assert.equal(applied.applied, true);
});

test("type model preserves unknown v0.3 extensions and blocks v0.2 writes", () => {
  const frontmatter = {
    kind: "mdbase.type",
    name: "note",
    version: 4,
    schema: {
      dialect: "json-schema-2020-12",
      "x-schema-note": "preserve",
      value: {
        type: "object",
        oneOf: [{ required: ["title"] }],
        properties: {
          title: { type: "string", "x-field": "preserve" },
        },
      },
    },
    collection: {
      display: { name_field: "title", "x-display": "preserve" },
      "x-placement": true,
    },
    match: {
      path_glob: "Notes/**/*.md",
      expr: { $expr: "record.published == true" },
    },
    lifecycle: { on_create: { set: { id: { uuid: true } } } },
    "x-plugin": { enabled: true },
  };
  const model = typeModelFromDocument(frontmatter, "# Note", "note");
  model.description = "Edited";
  model.fields[0].definition.description = "Visible field description";
  const output = frontmatterFromTypeModel(model);
  assert.deepEqual(output["x-plugin"], { enabled: true });
  assert.deepEqual(output.lifecycle, frontmatter.lifecycle);
  assert.equal(((output.schema as Record<string, unknown>)["x-schema-note"]), "preserve");
  const schema = (output.schema as { value: Record<string, unknown> }).value;
  assert.deepEqual(schema.oneOf, [{ required: ["title"] }]);
  assert.equal(((schema.properties as Record<string, Record<string, unknown>>).title)["x-field"], "preserve");
  assert.equal(
    ((schema.properties as Record<string, Record<string, unknown>>).title).description,
    "Visible field description",
  );
  assert.equal((output.collection as Record<string, unknown>)["x-placement"], true);
  assert.equal(
    ((output.collection as Record<string, Record<string, unknown>>).display)["x-display"],
    "preserve",
  );
  assert.deepEqual((output.match as Record<string, unknown>).expr, { $expr: "record.published == true" });

  const legacy = typeModelFromDocument(taskType(), "# Task", "task");
  assert.throws(() => frontmatterFromTypeModel(legacy), /read-only/);
});

test("type editing protects schema references, v0.3 names, and required-field removal", () => {
  const referenced = typeModelFromDocument({
    kind: "mdbase.type",
    name: "external",
    schema: {
      dialect: "json-schema-2020-12",
      ref: "../schemas/external.schema.json",
    },
  }, "# External", "external");
  assert.equal(referenced.fields.length, 0);
  assert.match(referenced.readOnlyReason ?? "", /schema\.ref/);
  assert.throws(() => frontmatterFromTypeModel(referenced), /referenced JSON Schema/);

  assert.equal(validateMdbaseTypeName("work-item_2"), "work-item_2");
  assert.throws(() => validateMdbaseTypeName("../escape"), /start with a letter|only letters/);
  assert.throws(() => validateMdbaseTypeName("file"), /reserved/);
  assert.throws(() => validateMdbaseTypeName(`a${"b".repeat(63)}`), /shorter than 64/);

  const schema = schemaFromV03Fields(
    { title: { type: "string", required: false } },
    {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  );
  assert.equal("required" in schema, false);
});

test("type model edits recursive lists, objects, and nested links without flattening schema", () => {
  const frontmatter = {
    kind: "mdbase.type",
    name: "catalog",
    version: 1,
    schema: {
      dialect: "json-schema-2020-12",
      value: {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["owner"],
                properties: {
                  owner: { type: "string", "x-field": "preserve" },
                },
              },
            },
          },
        },
      },
    },
    collection: {
      links: {
        "matrix[][].owner": {
          target_type: "person",
          validate_exists: true,
          "x-link": "preserve",
        },
      },
    },
  };
  const model = typeModelFromDocument(frontmatter, "# Catalog", "catalog");
  const matrix = model.fields[0].definition;
  const firstItems = matrix.items as Record<string, unknown>;
  const secondItems = firstItems.items as Record<string, unknown>;
  const objectFields = secondItems.fields as Record<string, Record<string, unknown>>;
  assert.equal(matrix.type, "list");
  assert.equal(firstItems.type, "list");
  assert.equal(secondItems.type, "object");
  assert.equal(objectFields.owner.type, "link");
  assert.equal(objectFields.owner.target, "person");
  objectFields.details = {
    type: "object",
    required: true,
    fields: {
      labels: {
        type: "list",
        items: {
          type: "object",
          fields: {
            value: { type: "string", required: true },
          },
        },
      },
    },
  };

  const output = frontmatterFromTypeModel(model);
  const schema = (output.schema as { value: Record<string, unknown> }).value;
  const matrixSchema = (schema.properties as Record<string, Record<string, unknown>>).matrix;
  const innerObject = ((matrixSchema.items as Record<string, unknown>).items as Record<string, unknown>);
  const innerProperties = innerObject.properties as Record<string, Record<string, unknown>>;
  assert.equal(matrixSchema.type, "array");
  assert.equal((matrixSchema.items as Record<string, unknown>).type, "array");
  assert.equal(innerObject.type, "object");
  assert.equal(innerObject.additionalProperties, false);
  assert.deepEqual(innerObject.required, ["owner", "details"]);
  assert.equal(innerProperties.owner.type, "string");
  assert.equal(innerProperties.owner["x-field"], "preserve");
  const labels = ((innerProperties.details.properties as Record<string, Record<string, unknown>>).labels);
  assert.equal(labels.type, "array");
  assert.equal((labels.items as Record<string, unknown>).type, "object");
  assert.deepEqual((labels.items as Record<string, unknown>).required, ["value"]);
  const link = ((output.collection as Record<string, unknown>).links as Record<string, Record<string, unknown>>)["matrix[][].owner"];
  assert.equal(link.target_type, "person");
  assert.equal(link.validate_exists, true);
  assert.equal(link["x-link"], "preserve");

  const collapsedModel = typeModelFromDocument(frontmatter, "# Catalog", "catalog");
  const collapsedMatrix = collapsedModel.fields[0].definition;
  const collapsedFirstItems = collapsedMatrix.items as Record<string, unknown>;
  const collapsedInner = collapsedFirstItems.items as Record<string, unknown>;
  collapsedInner.type = "string";
  const collapsedOutput = frontmatterFromTypeModel(collapsedModel);
  const collapsedSchema = (collapsedOutput.schema as { value: Record<string, unknown> }).value;
  const collapsedMatrixSchema = (collapsedSchema.properties as Record<string, Record<string, unknown>>).matrix;
  const collapsedInnerSchema = ((collapsedMatrixSchema.items as Record<string, unknown>).items as Record<string, unknown>);
  assert.equal(collapsedInnerSchema.type, "string");
  for (const staleKeyword of ["properties", "required", "additionalProperties", "items"]) {
    assert.equal(staleKeyword in collapsedInnerSchema, false);
  }
  assert.equal(
    collapsedOutput.collection === undefined
      || !("links" in (collapsedOutput.collection as Record<string, unknown>)),
    true,
  );

  objectFields.owner.type = "string";
  const withoutLink = frontmatterFromTypeModel(model);
  assert.equal(
    withoutLink.collection === undefined
      || !("links" in (withoutLink.collection as Record<string, unknown>)),
    true,
  );
});

test("Obsidian mirror adapter rejects traversal and reserved paths", async () => {
  const vault = new MemoryVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.write("../escape.md", "x"), /escapes the collection root/);
  await assert.rejects(fs.write(".obsidian/plugins/evil.js", "x"), /reserved path/);
  await assert.rejects(fs.write(".mdbase/connect-role.json", "x"), /reserved path/);
  await fs.write("notes/ok.md", "hello");
  assert.equal(await fs.read("notes/ok.md"), "hello");
  await fs.remove("notes/ok.md");
  assert.equal(await fs.read("notes/ok.md"), null);
});

test("Obsidian mirror adapter round-trips and verifies binary files", async () => {
  const vault = new MemoryVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  await fs.writeBinary("attachments/tasks/task-1/photo.png", (async function* () {
    yield bytes.slice(0, 3);
    yield bytes.slice(3);
  })());

  assert.deepEqual(await fs.inspectBinary("attachments/tasks/task-1/photo.png"), {
    size: bytes.byteLength,
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  assert.deepEqual(await fs.listBinary(new Set()), ["attachments/tasks/task-1/photo.png"]);
  const source = await fs.readBinary("attachments/tasks/task-1/photo.png");
  assert.ok(source);
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  assert.deepEqual(chunks, [bytes]);

  const replacement = new Uint8Array([9, 8, 7]);
  await fs.writeBinary("attachments/tasks/task-1/photo.png", (async function* () {
    yield replacement;
  })());
  assert.equal((await fs.inspectBinary("attachments/tasks/task-1/photo.png"))?.size, 3);
  await assert.rejects(
    fs.writeBinary(".obsidian/photo.png", (async function* () { yield bytes; })()),
    /reserved path/,
  );
});

test("Connect enrollment keeps credentials out of plugin data and refuses local-authority vaults", async () => {
  const pairingId = "11111111-1111-4111-8111-111111111111";
  const collectionId = "22222222-2222-4222-8222-222222222222";
  const replicaId = "33333333-3333-4333-8333-333333333333";
  let requests = 0;
  const pairingCollectionIds: unknown[] = [];
  const client = new MirrorEnrollmentClient({
    request: async (request) => {
      requests += 1;
      if (request.url.endsWith("/v1/mirror-pairing-requests")) {
        pairingCollectionIds.push((request.body as Record<string, unknown>).collection_id);
        return {
          status: 201,
          body: {
            pairing_id: pairingId,
            pairing_secret: "refresh-secret-with-sufficient-entropy-123",
            verification_uri: `https://connect.example/mirror/${pairingId}`,
            expires_in: 60,
          },
        };
      }
      return {
        status: 200,
        body: {
          status: "paired",
          replica: {
            id: replicaId,
            collection_id: collectionId,
            name: "Obsidian mobile",
            mode: "read_write",
          },
          token: "access-token-with-sufficient-entropy-456",
          token_expires_at: "2099-01-01T00:00:00.000Z",
          sync_url: `https://sync.example/v1/authorities/${collectionId}/sync`,
        },
      };
    },
  });
  const secrets = new Map<string, string>();
  const vault = new MemoryVault();
  let storedProfile: import("../src/connectSync").MirrorProfile | null = null;
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: (id: string, value: string) => void secrets.set(id, value),
      getSecret: (id: string) => secrets.get(id) ?? null,
      listSecrets: () => [...secrets.keys()],
    },
  } as never, {
    getMirrorProfile: () => storedProfile,
    saveMirrorProfile: async (profile) => {
      storedProfile = profile;
    },
  }, { enrollmentClient: client });
  let verification = "";
  const profile = await controller.enroll({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian mobile",
    mode: "read_write",
    collectionId,
  }, {
    onVerification: (value) => {
      verification = value.verificationUri;
    },
  });
  assert.equal(verification, `https://connect.example/mirror/${pairingId}`);
  assert.equal(profile.collectionId, collectionId);
  assert.equal(JSON.stringify(storedProfile).includes("access-token"), false);
  assert.equal(JSON.stringify(storedProfile).includes("refresh-secret"), false);
  assert.equal(secrets.size, 2);
  assert.deepEqual(JSON.parse(vault.read(".mdbase/connect-role.json") ?? "{}"), {
    version: 1,
    role: "mirror",
    collection_id: collectionId,
  });

  const localVault = new MemoryVault();
  await localVault.create(
    "mdbase.yaml",
    `${JSON.stringify({
      spec_version: "0.3.0",
      "x-mdbase-connect": { collection_id: collectionId },
    }, null, 2)}\n`,
  );
  const localController = new ConnectSyncController({
    vault: localVault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => undefined,
  }, { enrollmentClient: client });
  const beforeRefusal = requests;
  await assert.rejects(
    localController.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Unsafe",
      mode: "read_only",
    }, { onVerification: () => undefined }),
    /Transfer authority explicitly/,
  );
  assert.equal(requests, beforeRefusal);

  const transferredVault = new MemoryVault();
  await transferredVault.create(
    "mdbase.yaml",
    `${JSON.stringify({
      spec_version: "0.3.0",
      "x-mdbase-connect": { collection_id: collectionId },
    }, null, 2)}\n`,
  );
  await transferredVault.createFolder(".mdbase");
  await transferredVault.create(".mdbase/connect-role.json", `${JSON.stringify({
    version: 1,
    role: "mirror",
    collection_id: collectionId,
  })}\n`);
  let transferredProfile: import("../src/connectSync").MirrorProfile | null = null;
  const transferredController = new ConnectSyncController({
    vault: transferredVault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => transferredProfile,
    saveMirrorProfile: async (profile) => {
      transferredProfile = profile;
    },
  }, { enrollmentClient: client });
  const transferred = await transferredController.enroll({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian mobile",
    mode: "read_write",
  }, { onVerification: () => undefined });
  assert.equal(transferred.collectionId, collectionId);
  assert.equal(transferred.syncUrl, `https://sync.example/v1/authorities/${collectionId}/sync`);
  assert.deepEqual(pairingCollectionIds, [collectionId, collectionId]);

  const existingCollection = new MemoryVault();
  await existingCollection.create("mdbase.yaml", v02Config());
  const existingController = new ConnectSyncController({
    vault: existingCollection,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => undefined,
  }, { enrollmentClient: client });
  const beforeExistingRefusal = requests;
  await assert.rejects(
    existingController.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Existing",
      mode: "read_only",
    }, { onVerification: () => undefined }),
    /already contains an mdbase collection/,
  );
  assert.equal(requests, beforeExistingRefusal);
});

test("failed enrollment persistence removes its temporary mirror-role marker", async () => {
  const collectionId = "22222222-2222-4222-8222-222222222222";
  const enrollmentClient = {
    enroll: async () => ({
      controlUrl: "https://connect.example",
      syncUrl: `https://sync.example/v1/authorities/${collectionId}/sync`,
      collectionId,
      replicaId: "33333333-3333-4333-8333-333333333333",
      mode: "read_write" as const,
      name: "Retryable",
      enrollmentId: "11111111-1111-4111-8111-111111111111",
      accessToken: "access-token",
      refreshCredential: "refresh-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    renew: async () => {
      throw new Error("not used");
    },
  };
  const vault = new MemoryVault();
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => {
      throw new Error("injected settings failure");
    },
  }, { enrollmentClient: enrollmentClient as never });
  await assert.rejects(
    controller.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Retryable",
      mode: "read_write",
    }, { onVerification: () => undefined }),
    /injected settings failure/,
  );
  assert.equal(vault.read(".mdbase/connect-role.json"), null);
});

test("device lease rejects concurrent mirror ownership and releases after failure", async () => {
  const lease = new DeviceMirrorLease("vault:collection");
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lease.runExclusive(async () => blocker);
  await assert.rejects(
    lease.runExclusive(async () => undefined),
    /already running/,
  );
  release();
  await first;
  await assert.rejects(
    lease.runExclusive(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  await lease.runExclusive(async () => undefined);
});

test("portable mirror materializes resources and records through Obsidian Vault APIs", async () => {
  const configuration = "spec_version: 0.3.0\n";
  const noteType = "---\nkind: mdbase.type\n---\n";
  const hosted = new MemoryAuthority({
    snapshotPageSize: 1,
    resources: {
      revision: "resources-1",
      spec_version: "0.3.0",
      types: [],
      contracts: [],
      documents: [
        { path: "mdbase.yaml", kind: "configuration", revision: sha256Revision(configuration), document: configuration },
        { path: "_types/note.md", kind: "type", revision: sha256Revision(noteType), document: noteType },
      ],
    },
  });
  hosted.seed([
    {
      record_id: "one",
      path: "notes/one.md",
      frontmatter: { type: "note", title: "One" },
      body: "First",
      types: ["note"],
    },
    {
      record_id: "two",
      path: "notes/two.md",
      frontmatter: { type: "note", title: "Two" },
      body: "Second",
      types: ["note"],
    },
  ]);
  const replica = hosted.registerReplica({ name: "Obsidian mobile", mode: "read_only" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
    lease: new MemoryMirrorLease(),
  });
  const preview = await mirror.previewInitialization();
  assert.equal(preview.download_documents, 4);
  assert.equal(preview.collisions.length, 0);
  await mirror.sync();
  assert.match(vault.read("notes/one.md") ?? "", /title: One/);
  assert.equal(vault.read("mdbase.yaml"), "spec_version: 0.3.0\n");
  assert.match(vault.read("_types/note.md") ?? "", /mdbase\.type/);
  assert.equal((await mirror.status()).state, "up_to_date");
});

test("writable mirror uploads local edits and collision preflight makes no writes", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{
    record_id: "one",
    path: "notes/one.md",
    frontmatter: { type: "note", title: "One" },
    body: "First",
    types: ["note"],
  }]);
  const replica = hosted.registerReplica({ name: "Obsidian", mode: "read_write" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
  });
  await mirror.sync();
  const file = vault.getAbstractFileByPath("notes/one.md") as TFile;
  await vault.modify(file, (vault.read(file.path) ?? "").replace("First", "Edited locally"));
  await mirror.sync();
  await vault.createFolder("Canvas Bases");
  await vault.create("Canvas Bases/Start Here.md", "# Start here\n\nNo metadata required.\n");
  await mirror.sync();
  await mirror.sync();
  const session = await hosted.transport(replica).openSession();
  const snapshot = await hosted.transport(replica).snapshot(session.snapshot_id);
  assert.equal(snapshot.records.find((record) => record.path === "notes/one.md")?.body.trim(), "Edited locally");
  const bodyOnlyRecord = snapshot.records.find((record) => record.path === "Canvas Bases/Start Here.md");
  assert.ok(bodyOnlyRecord);
  assert.deepEqual(bodyOnlyRecord.frontmatter, {});
  assert.equal(bodyOnlyRecord.body, "# Start here\n\nNo metadata required.\n");
  assert.deepEqual(bodyOnlyRecord.types, []);
  assert.equal(vault.read("Canvas Bases/Start Here.md"), "# Start here\n\nNo metadata required.\n");

  const collisionVault = new MemoryVault();
  await collisionVault.create("notes/one.md", "unmanaged bytes");
  const collisionState = new MemoryMirrorStateStore();
  const collisionReplica = hosted.registerReplica({ name: "Collision actual", mode: "read_only" });
  const checkedMirror = new DirectoryMirror(collisionReplica, hosted.transport(collisionReplica), {
    fileSystem: new ObsidianMirrorFileSystem(collisionVault as never),
    stateStore: collisionState,
  });
  await assert.rejects(checkedMirror.sync(), /already exist|collis|differ/i);
  assert.equal(collisionVault.read("notes/one.md"), "unmanaged bytes");
  assert.equal(await collisionState.read(), null);
});

test("interrupted mirror write does not advance the checkpoint and a retry converges", async () => {
  const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
  hosted.seed([
    {
      record_id: "one",
      path: "notes/one.md",
      frontmatter: { type: "note", title: "One" },
      body: "One",
      types: ["note"],
    },
    {
      record_id: "two",
      path: "notes/two.md",
      frontmatter: { type: "note", title: "Two" },
      body: "Two",
      types: ["note"],
    },
  ]);
  const replica = hosted.registerReplica({ name: "Fault injection", mode: "read_only" });
  const vault = new MemoryVault();
  vault.failCreatePath = "notes/two.md";
  const state = new MemoryMirrorStateStore();
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
  });
  await assert.rejects(mirror.sync(), /injected adapter create failure/);
  assert.equal(await state.read(), null);
  vault.failCreatePath = null;
  await mirror.sync();
  assert.equal((await mirror.status()).state, "up_to_date");
  assert.equal(vault.getMarkdownFiles().length, 2);
});

test("portable mirror processes a 2,000-document mobile-shaped collection within the regression budget", async () => {
  const hosted = new MemoryAuthority({ snapshotPageSize: 200 });
  hosted.seed(Array.from({ length: 2_000 }, (_, index) => ({
    record_id: `record-${index}`,
    path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { type: "note", title: `Record ${index}`, tags: ["profile"] },
    body: `Body ${index}`,
    types: ["note"],
  })));
  const replica = hosted.registerReplica({ name: "Performance", mode: "read_only" });
  const vault = new MemoryVault();
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new MemoryMirrorStateStore(),
  });
  const started = performance.now();
  await mirror.sync();
  const elapsed = performance.now() - started;
  assert.equal(vault.getMarkdownFiles().length, 2_000);
  assert.ok(elapsed < 3_000, `2,000-document mirror took ${elapsed.toFixed(1)}ms`);
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
