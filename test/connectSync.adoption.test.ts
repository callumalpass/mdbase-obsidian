import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { AuthorityImportSnapshot } from "@mdbase/connect-protocol";
import {
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError,
  type AuthorityAdoptionClient,
  type AuthorityAdoptionSession,
  type CompletedAuthorityAdoption,
  type PreparedAuthorityAdoption,
} from "@mdbase/connect-sync/adoption";
import type {
  MirrorEnrollment,
  MirrorEnrollmentClient,
} from "@mdbase/connect-sync/enrollment";
import {
  ConnectSyncController,
  type ConnectSyncSettingsHost,
  type MirrorProfile,
} from "../src/connectSync";

const TestFile = TFile as unknown as { new(path: string): TFile };
const TestFolder = TFolder as unknown as { new(path: string): TFolder };

class TestVault {
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Set<string>();

  readonly adapter = {
    exists: async (path: string) => this.files.has(normalizePath(path)) || this.folders.has(normalizePath(path)),
    read: async (path: string) => {
      const entry = this.files.get(normalizePath(path));
      if (!entry) throw new Error(`Missing file: ${path}`);
      return entry.content;
    },
    write: async (path: string, content: string) => {
      await this.put(path, content);
    },
    remove: async (path: string) => {
      this.files.delete(normalizePath(path));
    },
  };

  getName(): string {
    return "Adoption test vault";
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file
      ?? (this.folders.has(normalized) ? new TestFolder(normalized) : null);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((file) => file.extension === "md");
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map(({ file }) => file);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async put(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    const file = this.files.get(normalized)?.file ?? new TestFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }
}

class TestSettings implements ConnectSyncSettingsHost {
  profile: MirrorProfile | null = null;

  getMirrorProfile(): MirrorProfile | null {
    return this.profile;
  }

  async saveMirrorProfile(profile: MirrorProfile | null): Promise<void> {
    this.profile = profile;
  }
}

interface FakeAdoptionOptions {
  failFinalUploadOnce?: boolean;
  loseFirstCompletionResponse?: boolean;
  editAfterFinalUpload?: () => Promise<void>;
}

class FakeAdoption {
  readonly collectionId: string;
  readonly adoptionId = randomUUID();
  readonly session: AuthorityAdoptionSession;
  uploads: AuthorityImportSnapshot[] = [];
  completionCalls = 0;
  state: "ready" | "activating" | "completed" = "ready";
  exchangeError: Error | null = null;
  private failedFinalUpload = false;

  constructor(
    collectionId: string,
    private readonly options: FakeAdoptionOptions = {},
  ) {
    this.collectionId = collectionId;
    this.session = {
      controlUrl: "https://connect.example",
      adoptionId: this.adoptionId,
      credential: "adp_test_secret_abcdefghijklmnopqrstuvwxyz",
      verificationUri: `https://connect.example/adopt/${this.adoptionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requested: {
        collectionId,
        displayName: "Test collection",
        sourceName: "Obsidian",
        retainMirror: true,
        mirrorName: "Obsidian",
      },
    };
  }

  async begin(input: { collectionId: string }): Promise<AuthorityAdoptionSession> {
    assert.equal(input.collectionId, this.collectionId);
    return this.session;
  }

  async waitForApproval(): Promise<PreparedAuthorityAdoption> {
    return this.prepared();
  }

  async exchange() {
    if (this.exchangeError) throw this.exchangeError;
    if (this.state === "completed") return this.completed();
    if (this.state === "activating") {
      return { status: "activating" as const, adoption: this.adoptionView("activating") };
    }
    return this.prepared();
  }

  async uploadSnapshot(
    _session: AuthorityAdoptionSession,
    _prepared: PreparedAuthorityAdoption,
    snapshot: AuthorityImportSnapshot,
  ): Promise<void> {
    if (this.options.failFinalUploadOnce && this.uploads.length === 1 && !this.failedFinalUpload) {
      this.failedFinalUpload = true;
      throw new Error("connection dropped during final upload");
    }
    this.uploads.push(structuredClone(snapshot));
    if (this.uploads.length >= 2) await this.options.editAfterFinalUpload?.();
  }

  async complete(
    _session: AuthorityAdoptionSession,
    snapshot: AuthorityImportSnapshot,
  ): Promise<CompletedAuthorityAdoption> {
    this.completionCalls += 1;
    this.state = "activating";
    if (this.options.loseFirstCompletionResponse && this.completionCalls === 1) {
      throw new AuthorityAdoptionOutcomeUnknownError("response lost after activation");
    }
    this.state = "completed";
    return {
      status: "completed",
      adoption: {
        ...this.adoptionView("completed"),
        manifest_digest: snapshot.manifest_digest,
        source_revision: snapshot.source_revision,
        final_head: snapshot.source_head,
      },
    };
  }

  mirrorEnrollmentSession() {
    return {
      controlUrl: this.session.controlUrl,
      pairingId: this.session.adoptionId,
      refreshCredential: this.session.credential,
      verificationUri: `https://connect.example/mirror/${this.session.adoptionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requested: {
        mirrorName: "Obsidian",
        mode: "read_write" as const,
        collectionId: this.collectionId,
      },
    };
  }

  async cancel(): Promise<void> {
    this.state = "ready";
  }

  private prepared(): PreparedAuthorityAdoption {
    return {
      status: "ready",
      adoption: this.adoptionView("prepared"),
      import: {
        manifest_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/manifest`,
        records_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/records`,
        finalize_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/finalize`,
        access_token: "ati_test_secret_abcdefghijklmnopqrstuvwxyz",
      },
      staged: {
        state: "receiving",
        manifest_digest: null,
        source_revision: null,
        source_head: null,
      },
    };
  }

  private completed(): CompletedAuthorityAdoption {
    const snapshot = this.uploads.at(-1)!;
    return {
      status: "completed",
      adoption: {
        ...this.adoptionView("completed"),
        manifest_digest: snapshot.manifest_digest,
        source_revision: snapshot.source_revision,
        final_head: snapshot.source_head,
      },
    };
  }

  private adoptionView(state: "prepared" | "activating" | "completed") {
    return {
      id: this.adoptionId,
      collection_id: this.collectionId,
      display_name: "Test collection",
      source_name: "Obsidian",
      retain_mirror: true,
      mirror_name: "Obsidian",
      state,
      authority_epoch: 2,
      final_head: null,
      manifest_digest: null,
      source_revision: null,
      expires_at: this.session.expiresAt,
    };
  }
}

class FakeEnrollment {
  constructor(private readonly collectionId: string) {}

  async waitForApproval(): Promise<MirrorEnrollment> {
    return this.enrollment();
  }

  async enroll(): Promise<MirrorEnrollment> {
    return this.enrollment();
  }

  private enrollment(): MirrorEnrollment {
    return {
      controlUrl: "https://connect.example",
      syncUrl: `https://provider.example/v1/authorities/${this.collectionId}/sync`,
      collectionId: this.collectionId,
      replicaId: randomUUID(),
      mode: "read_write",
      name: "Obsidian",
      enrollmentId: randomUUID(),
      accessToken: "access-token",
      refreshCredential: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

async function fixture(options: FakeAdoptionOptions = {}) {
  const collectionId = randomUUID();
  const vault = new TestVault();
  await vault.put("mdbase.yaml", JSON.stringify({
    spec_version: "0.3.0",
    name: "Test collection",
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: ["_types", ".obsidian", ".git", ".trash", ".mdbase"],
    },
    "x-mdbase-connect": { collection_id: collectionId },
    "x-obsidian": { bases: { include: ["views/**/*.base"] } },
  }));
  await vault.put("_types/task.md", `---\n${JSON.stringify({
    kind: "mdbase.type",
    name: "task",
    version: 1,
    match: { path_glob: "tasks/**/*.md" },
    schema: {
      dialect: "json-schema-2020-12",
      value: { type: "object", properties: { title: { type: "string" } } },
    },
  })}\n---\n\nTask`);
  await vault.put("tasks/one.md", `---\n${JSON.stringify({ title: "One" })}\n---\n\nBody`);
  await vault.put("views/tasks.base", "views: []\n");
  const secrets = new Map<string, string>();
  const app = {
    vault,
    secretStorage: {
      setSecret: (id: string, value: string) => secrets.set(id, value),
      getSecret: (id: string) => secrets.get(id) || null,
    },
  };
  const settings = new TestSettings();
  const adoption = new FakeAdoption(collectionId, options);
  const controller = new ConnectSyncController(
    app as never,
    settings,
    {
      adoptionClient: adoption as unknown as AuthorityAdoptionClient,
      enrollmentClient: new FakeEnrollment(collectionId) as unknown as MirrorEnrollmentClient,
    },
  );
  await controller.initialize();
  return { app, vault, settings, adoption, controller, collectionId };
}

const callbacks = {
  onVerification: () => undefined,
  onStatus: () => undefined,
};

test("adopts every canonical resource and retains the existing vault as a mirror", async () => {
  const { vault, settings, adoption, controller, collectionId } = await fixture();
  const opaqueDocument = "---\ntitle: [unterminated\n---\nOpaque body\n";
  await vault.put("tasks/opaque.md", opaqueDocument);
  const profile = await controller.adoptLocalCollection({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian",
  }, callbacks);

  assert.equal(profile.collectionId, collectionId);
  assert.equal(settings.profile?.mode, "read_write");
  assert.equal(adoption.uploads.length, 2);
  const final = adoption.uploads[1]!;
  assert.deepEqual(
    final.resources.documents!.map(({ kind, path }) => [kind, path]),
    [
      ["configuration", "mdbase.yaml"],
      ["type", "_types/task.md"],
      ["view", "views/tasks.base"],
    ],
  );
  assert.deepEqual(final.records.map(({ path }) => path), ["tasks/one.md", "tasks/opaque.md"]);
  assert.equal(
    final.records.find(({ path }) => path === "tasks/opaque.md")?.document,
    opaqueDocument,
  );
  assert.equal(await vault.adapter.exists(".mdbase/connect-role.json"), true);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption.json"), false);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption-snapshot.json"), false);
});

test("a lost activation response keeps the exact snapshot fenced across restart", async () => {
  const state = await fixture({ loseFirstCompletionResponse: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
    (error: unknown) => error instanceof AuthorityAdoptionOutcomeUnknownError,
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "activating");
  assert.throws(() => state.controller.assertLocalAuthorityWritable(), /frozen|authoritative/i);
  const digest = state.adoption.uploads.at(-1)?.manifest_digest;

  const resumed = new ConnectSyncController(
    state.app as never,
    state.settings,
    {
      adoptionClient: state.adoption as unknown as AuthorityAdoptionClient,
      enrollmentClient: new FakeEnrollment(state.collectionId) as unknown as MirrorEnrollmentClient,
    },
  );
  await resumed.initialize();
  await resumed.resumeAdoption(callbacks);

  assert.equal(state.adoption.uploads.at(-1)?.manifest_digest, digest);
  assert.equal(state.adoption.uploads.length, 2);
  assert.equal(resumed.getAdoptionMarker(), null);
  assert.equal(state.settings.profile?.collectionId, state.collectionId);
});

test("an interrupted final upload resumes from the persisted fenced snapshot", async () => {
  const state = await fixture({ failFinalUploadOnce: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
    /connection dropped/,
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "fenced");
  assert.throws(() => state.controller.assertLocalAuthorityWritable(), /frozen/i);

  await state.controller.resumeAdoption(callbacks);
  assert.equal(state.adoption.uploads.length, 2);
  assert.equal(state.adoption.completionCalls, 1);
  assert.equal(state.settings.profile?.collectionId, state.collectionId);
});

test("edits arriving after the fence remain local for the new mirror instead of changing the activated snapshot", async () => {
  let state: Awaited<ReturnType<typeof fixture>>;
  state = await fixture({
    editAfterFinalUpload: async () => {
      await state.vault.put("tasks/one.md", `---\n${JSON.stringify({ title: "After fence" })}\n---\n\nBody`);
    },
  });
  await state.controller.adoptLocalCollection({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian",
  }, callbacks);

  assert.match(state.adoption.uploads.at(-1)?.records[0]?.document ?? "", /"title":"One"/);
  assert.match(await state.vault.adapter.read("tasks/one.md"), /After fence/);
  assert.equal(state.settings.profile?.mode, "read_write");
});

test("a pre-activation checkpoint can be cancelled without leaving the vault fenced", async () => {
  const state = await fixture({ failFinalUploadOnce: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "fenced");
  await state.controller.cancelAdoption();
  assert.equal(state.controller.getAdoptionMarker(), null);
  assert.doesNotThrow(() => state.controller.assertLocalAuthorityWritable());
});

test("an expired server checkpoint safely unfreezes the local authority", async () => {
  const state = await fixture({ loseFirstCompletionResponse: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "activating");
  state.adoption.exchangeError = new AuthorityAdoptionError(
    "authority_adoption_expired",
    "expired",
    409,
  );

  await assert.rejects(
    state.controller.resumeAdoption(callbacks),
    /remains the writable local authority/,
  );
  assert.equal(state.controller.getAdoptionMarker(), null);
  assert.doesNotThrow(() => state.controller.assertLocalAuthorityWritable());
});
