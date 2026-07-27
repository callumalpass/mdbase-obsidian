import {
  App,
  normalizePath,
  parseYaml,
  requestUrl,
  TFile,
  TFolder,
  Vault,
} from "obsidian";
import type {
  JsonObject,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage,
} from "@mdbase/connect-protocol";
import {
  SyncError,
  type SyncTransport,
} from "@mdbase/connect-sync";
import {
  DirectoryMirror,
  type DirectoryMirrorOptions,
  type MirrorFileSystem,
  type MirrorInitializationPreview,
  type MirrorLease,
  type MirrorProgress,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus,
  WritableDirectoryMirror,
} from "@mdbase/connect-sync/mirror";
import {
  MirrorEnrollmentClient,
  type MirrorEnrollment,
  type MirrorEnrollmentMode,
  type MirrorEnrollmentRequester,
  type MirrorEnrollmentStatus,
  type MirrorEnrollmentVerification,
} from "@mdbase/connect-sync/enrollment";
import { normalizeSafeRelativePath } from "./mdbaseCore";

export interface MirrorProfile {
  version: 1;
  syncUrl: string;
  controlUrl: string;
  collectionId: string;
  replicaId: string;
  mode: MirrorEnrollmentMode;
  name: string;
  enrollmentId: string;
  accessTokenExpiresAt: string;
}

export interface EnrollMirrorInput {
  controlUrl: string;
  mirrorName: string;
  mode: MirrorEnrollmentMode;
  collectionId?: string;
}

export interface EnrollMirrorCallbacks {
  onVerification(verification: MirrorEnrollmentVerification): void | Promise<void>;
  onStatus?(status: MirrorEnrollmentStatus): void;
  signal?: AbortSignal;
}

export interface ConnectSyncSettingsHost {
  getMirrorProfile(): MirrorProfile | null;
  saveMirrorProfile(profile: MirrorProfile | null): Promise<void>;
}

const ROLE_MARKER_PATH = ".mdbase/connect-role.json";
const STATE_DATABASE = "mdbase-obsidian-connect";
const STATE_STORE = "mirrors";
const ACCESS_SECRET_PREFIX = "mdbase-connect-access-";
const REFRESH_SECRET_PREFIX = "mdbase-connect-refresh-";
const TOKEN_RENEWAL_WINDOW_MS = 5 * 60 * 1_000;
const RESERVED_WRITE_PREFIXES = [".git/", ".obsidian/", ".trash/", ".mdbase/"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MirrorMarker {
  version: 1;
  role: "mirror";
  collection_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonResponse(text: string, parsed: unknown): unknown {
  if (parsed !== undefined && parsed !== null) return parsed;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function retryAfterMilliseconds(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function createObsidianEnrollmentRequester(): MirrorEnrollmentRequester {
  return async (request) => {
    if (request.signal?.aborted) throw new DOMException("Enrollment cancelled.", "AbortError");
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      contentType: request.body === undefined ? undefined : "application/json",
      throw: false,
    });
    if (request.signal?.aborted) throw new DOMException("Enrollment cancelled.", "AbortError");
    return {
      status: response.status,
      body: parseJsonResponse(response.text, response.json),
      retryAfterMs: retryAfterMilliseconds(response.headers),
    };
  };
}

/**
 * Sync transport backed by Obsidian's requestUrl. This keeps the portable SDK
 * usable on mobile and avoids browser CORS restrictions without importing the
 * SDK's Node entry point.
 */
export class ObsidianSyncTransport<Frontmatter extends JsonObject = JsonObject>
implements SyncTransport<Frontmatter> {
  private readonly syncUrl: string;

  constructor(
    syncUrl: string,
    private readonly accessToken: string,
  ) {
    let endpoint: URL;
    try {
      endpoint = new URL(syncUrl);
    } catch {
      throw new SyncError("invalid_sync_url", "Sync URL must be an absolute authority endpoint.");
    }
    if (
      !(
        endpoint.protocol === "https:"
        || (
          endpoint.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
        )
      )
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || !/^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sync\/?$/i.test(endpoint.pathname)
    ) {
      throw new SyncError("invalid_sync_url", "Sync URL must identify one authority sync endpoint.");
    }
    this.syncUrl = endpoint.href.replace(/\/$/, "");
  }

  openSession(): Promise<SyncSession> {
    return this.request("POST", "sessions");
  }

  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `snapshot?${query.toString()}`);
  }

  changes(after: number, limit = 200): Promise<SyncChangesPage<Frontmatter>> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.request("GET", `changes?${query.toString()}`);
  }

  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>> {
    return this.request("POST", "mutations", mutation);
  }

  private async request<Result>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result> {
    const response = await requestUrl({
      url: `${this.syncUrl}/${path}`,
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      throw: false,
    });
    const value = parseJsonResponse(response.text, response.json);
    if (response.status < 200 || response.status >= 300) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : {};
      throw new SyncError(
        typeof error.code === "string" ? error.code : "sync_failed",
        typeof error.message === "string" ? error.message : `Sync request failed (${response.status}).`,
      );
    }
    return value as Result;
  }
}

function safeMirrorPath(input: string): string {
  const path = normalizeSafeRelativePath(input);
  if (path === ".mdbase" || RESERVED_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new SyncError("unsafe_mirror_path", `The collection authority attempted to write a reserved path: ${path}`);
  }
  return path;
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const folder = normalizePath(path).replace(/\/+$/, "");
  if (!folder) return;
  let current = "";
  for (const segment of folder.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const existing = vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new SyncError("mirror_path_collision", `A file blocks the mirror folder ${current}.`);
    if (await vault.adapter.exists(current)) continue;
    await vault.createFolder(current);
  }
}

export class ObsidianMirrorFileSystem implements MirrorFileSystem {
  constructor(private readonly vault: Vault) {}

  async read(input: string): Promise<string | null> {
    const path = safeMirrorPath(input);
    const file = this.vault.getAbstractFileByPath(path);
    if (file == null) return null;
    if (!(file instanceof TFile)) {
      throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    }
    return this.vault.cachedRead(file);
  }

  async write(input: string, value: string): Promise<void> {
    const path = safeMirrorPath(input);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, path.slice(0, slash));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      throw new SyncError("mirror_path_collision", `A folder blocks the mirror file ${path}.`);
    }
    if (existing instanceof TFile) {
      await this.vault.modify(existing, value);
    } else {
      await this.vault.create(path, value);
    }
  }

  async remove(input: string): Promise<void> {
    const path = safeMirrorPath(input);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing == null) return;
    if (!(existing instanceof TFile)) {
      throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    }
    await this.vault.delete(existing, true);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return this.vault
      .getMarkdownFiles()
      .map((file) => normalizePath(file.path))
      .filter((path) => !excluded.has(path))
      .filter((path) => !RESERVED_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix)))
      .sort();
  }
}

export class IndexedDbMirrorStateStore implements MirrorStateStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly key: string) {}

  async read(): Promise<MirrorState | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(this.key);
      request.onsuccess = () => resolve((request.result as MirrorState | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async write(state: MirrorState): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STATE_STORE, "readwrite");
      transaction.objectStore(STATE_STORE).put(state, this.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new SyncError("storage_unavailable", "IndexedDB is required for persistent mirror state.");
    }
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(STATE_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STATE_STORE)) {
          request.result.createObjectStore(STATE_STORE);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return this.database;
  }
}

export class DeviceMirrorLease implements MirrorLease {
  private static readonly active = new Set<string>();

  constructor(private readonly key: string) {}

  async runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (DeviceMirrorLease.active.has(this.key)) {
      throw new SyncError("mirror_busy", "A mirror operation is already running for this vault.");
    }
    DeviceMirrorLease.active.add(this.key);
    try {
      return await operation();
    } finally {
      DeviceMirrorLease.active.delete(this.key);
    }
  }
}

export interface ConnectSyncControllerOptions {
  stateStoreFactory?: (profile: MirrorProfile) => MirrorStateStore;
  fileSystem?: MirrorFileSystem;
  leaseFactory?: (profile: MirrorProfile) => MirrorLease;
  enrollmentClient?: MirrorEnrollmentClient;
  transportFactory?: (
    profile: MirrorProfile,
    accessToken: string,
  ) => SyncTransport<JsonObject>;
}

export class ConnectSyncController {
  private progress: MirrorProgress | null = null;
  private readonly fileSystem: MirrorFileSystem;
  private readonly enrollmentClient: MirrorEnrollmentClient;

  constructor(
    private readonly app: App,
    private readonly settingsHost: ConnectSyncSettingsHost,
    private readonly options: ConnectSyncControllerOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? new ObsidianMirrorFileSystem(app.vault);
    this.enrollmentClient = options.enrollmentClient ?? new MirrorEnrollmentClient({
      request: createObsidianEnrollmentRequester(),
    });
  }

  getProgress(): MirrorProgress | null {
    return this.progress ? { ...this.progress } : null;
  }

  async enroll(
    input: EnrollMirrorInput,
    callbacks: EnrollMirrorCallbacks,
  ): Promise<MirrorProfile> {
    const collectionId = await this.assertCanBecomeMirror(input.collectionId);
    const enrollment = await this.enrollmentClient.enroll({
      ...input,
      ...(collectionId ? { collectionId } : {}),
    }, callbacks);
    const markerCreated = await this.markMirror(enrollment.collectionId);
    try {
      await this.persistEnrollment(enrollment);
    } catch (error) {
      if (markerCreated) {
        try {
          await this.app.vault.adapter.remove(ROLE_MARKER_PATH);
        } catch {
          throw new SyncError(
            "enrollment_recovery_required",
            `Enrollment settings could not be saved and the temporary role marker could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw error;
    }
    return this.requireProfile();
  }

  async preview(): Promise<MirrorInitializationPreview> {
    const mirror = await this.createMirror();
    return mirror.previewInitialization();
  }

  async status(): Promise<MirrorStatus | null> {
    const profile = this.settingsHost.getMirrorProfile();
    if (!profile) return null;
    await this.assertMirror(profile.collectionId);
    const mirror = await this.createMirror();
    return mirror.status();
  }

  async sync(onProgress?: (progress: MirrorProgress) => void): Promise<MirrorStatus> {
    const mirror = await this.createMirror((next) => {
      this.progress = next;
      onProgress?.({ ...next });
    });
    try {
      await mirror.sync();
      return mirror.status();
    } finally {
      this.progress = null;
    }
  }

  async resolveConflict(recordId: string, resolution: "local" | "remote"): Promise<MirrorStatus> {
    const mirror = await this.createMirror();
    await mirror.resolveConflict(recordId, resolution);
    return mirror.status();
  }

  private async createMirror(onProgress?: (progress: MirrorProgress) => void): Promise<DirectoryMirror<JsonObject>> {
    const profile = this.requireProfile();
    await this.assertMirror(profile.collectionId);
    const accessToken = await this.freshAccessToken(profile);
    const transport = this.options.transportFactory?.(profile, accessToken)
      ?? new ObsidianSyncTransport(profile.syncUrl, accessToken);
    const mirrorOptions: DirectoryMirrorOptions = {
      stateStore: this.options.stateStoreFactory?.(profile)
        ?? new IndexedDbMirrorStateStore(`${profile.collectionId}:${profile.replicaId}`),
      fileSystem: this.fileSystem,
      lease: this.options.leaseFactory?.(profile)
        ?? new DeviceMirrorLease(`${profile.collectionId}:${profile.replicaId}`),
      onProgress,
    };
    return profile.mode === "read_write"
      ? new WritableDirectoryMirror(profile.replicaId, transport, mirrorOptions)
      : new DirectoryMirror(profile.replicaId, transport, mirrorOptions);
  }

  private requireProfile(): MirrorProfile {
    const profile = this.settingsHost.getMirrorProfile();
    if (!profile) throw new SyncError("mirror_not_configured", "This vault is not connected to a collection authority.");
    return profile;
  }

  private accessSecretId(collectionId: string): string {
    return `${ACCESS_SECRET_PREFIX}${collectionId.toLowerCase()}`;
  }

  private refreshSecretId(collectionId: string): string {
    return `${REFRESH_SECRET_PREFIX}${collectionId.toLowerCase()}`;
  }

  private async persistEnrollment(enrollment: MirrorEnrollment): Promise<void> {
    this.app.secretStorage.setSecret(this.accessSecretId(enrollment.collectionId), enrollment.accessToken);
    this.app.secretStorage.setSecret(this.refreshSecretId(enrollment.collectionId), enrollment.refreshCredential);
    await this.settingsHost.saveMirrorProfile({
      version: 1,
      syncUrl: enrollment.syncUrl,
      controlUrl: enrollment.controlUrl,
      collectionId: enrollment.collectionId,
      replicaId: enrollment.replicaId,
      mode: enrollment.mode,
      name: enrollment.name,
      enrollmentId: enrollment.enrollmentId,
      accessTokenExpiresAt: enrollment.accessTokenExpiresAt,
    });
  }

  private async freshAccessToken(profile: MirrorProfile): Promise<string> {
    const accessSecretId = this.accessSecretId(profile.collectionId);
    const current = this.app.secretStorage.getSecret(accessSecretId);
    const expiresAt = Date.parse(profile.accessTokenExpiresAt);
    if (current && Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_RENEWAL_WINDOW_MS) {
      return current;
    }
    const refreshCredential = this.app.secretStorage.getSecret(this.refreshSecretId(profile.collectionId));
    if (!refreshCredential) {
      throw new SyncError("mirror_credentials_missing", "The mirror refresh credential is missing. Re-enroll this vault.");
    }
    const renewed = await this.enrollmentClient.renew({
      controlUrl: profile.controlUrl,
      syncUrl: profile.syncUrl,
      collectionId: profile.collectionId,
      replicaId: profile.replicaId,
      mode: profile.mode,
      name: profile.name,
      enrollmentId: profile.enrollmentId,
      accessToken: current ?? "",
      refreshCredential,
      accessTokenExpiresAt: profile.accessTokenExpiresAt,
    });
    await this.persistEnrollment(renewed);
    return renewed.accessToken;
  }

  private async assertCanBecomeMirror(collectionId?: string): Promise<string | undefined> {
    const marker = await this.readMarker();
    const localCollectionId = await this.readPortableCollectionId();
    if (localCollectionId && !marker) {
      throw new SyncError(
        "local_authority_requires_transfer",
        "This vault has a local Connect identity. Transfer authority explicitly before using it as a mirror.",
      );
    }
    if (localCollectionId && marker?.collection_id !== localCollectionId) {
      throw new SyncError(
        "mirror_identity_conflict",
        "The vault identity and mirror role marker identify different collections.",
      );
    }
    const profile = this.settingsHost.getMirrorProfile();
    const expectedCollectionId = profile?.collectionId ?? collectionId;
    if (
      marker
      && expectedCollectionId
      && marker.collection_id !== expectedCollectionId
    ) {
      throw new SyncError(
        "mirror_identity_conflict",
        "This vault is already marked as a different mirror.",
      );
    }
    if (!marker && !profile && await this.app.vault.adapter.exists("mdbase.yaml")) {
      throw new SyncError(
        "existing_collection_requires_transfer",
        "This vault already contains an mdbase collection. Connect an empty vault, or transfer collection authority explicitly.",
      );
    }
    return expectedCollectionId ?? marker?.collection_id;
  }

  private async readPortableCollectionId(): Promise<string | null> {
    if (!(await this.app.vault.adapter.exists("mdbase.yaml"))) return null;
    let parsed: unknown;
    try {
      parsed = parseYaml(await this.app.vault.adapter.read("mdbase.yaml"));
    } catch {
      throw new SyncError(
        "invalid_collection_configuration",
        "mdbase.yaml must contain valid YAML.",
      );
    }
    if (!isRecord(parsed)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "mdbase.yaml must contain a YAML mapping.",
      );
    }
    const extension = parsed["x-mdbase-connect"];
    if (extension === undefined) return null;
    if (!isRecord(extension)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "x-mdbase-connect must be a YAML mapping.",
      );
    }
    const collectionId = extension.collection_id;
    if (collectionId === undefined) return null;
    if (typeof collectionId !== "string" || !UUID_PATTERN.test(collectionId)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "x-mdbase-connect.collection_id must be a UUID string.",
      );
    }
    return collectionId;
  }

  private async markMirror(collectionId: string): Promise<boolean> {
    const marker = await this.readMarker();
    if (marker) {
      if (marker.collection_id !== collectionId) {
        throw new SyncError("mirror_identity_conflict", "This vault already mirrors a different collection authority.");
      }
      return false;
    }
    await ensureFolder(this.app.vault, ".mdbase");
    await this.app.vault.adapter.write(ROLE_MARKER_PATH, `${JSON.stringify({
      version: 1,
      role: "mirror",
      collection_id: collectionId,
    } satisfies MirrorMarker, null, 2)}\n`);
    return true;
  }

  private async assertMirror(collectionId: string): Promise<void> {
    const marker = await this.readMarker();
    if (!marker || marker.collection_id !== collectionId) {
      throw new SyncError(
        "mirror_marker_missing",
        "The vault's mirror role marker is missing or does not match this connection.",
      );
    }
  }

  private async readMarker(): Promise<MirrorMarker | null> {
    if (!(await this.app.vault.adapter.exists(ROLE_MARKER_PATH))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.app.vault.adapter.read(ROLE_MARKER_PATH));
    } catch {
      throw new SyncError("invalid_mirror_marker", "The mirror role marker is corrupt.");
    }
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.role !== "mirror"
      || typeof parsed.collection_id !== "string"
      || !UUID_PATTERN.test(parsed.collection_id)
    ) {
      throw new SyncError("invalid_mirror_marker", "The mirror role marker is invalid.");
    }
    return parsed as unknown as MirrorMarker;
  }
}
