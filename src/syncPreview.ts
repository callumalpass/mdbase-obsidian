import type { CollectionFileDescriptor, SyncChange } from "@mdbase-dev/connect-protocol";
import type { MirrorBinaryInfo, MirrorInitializationPreview, MirrorState } from "@mdbase-dev/connect-sync/mirror";

export type SyncPreviewDirection = "download" | "upload" | "attention";
export type SyncPreviewAction = "create" | "update" | "rename" | "delete" | "replace" | "fix";

export interface SyncPreviewEntry {
  kind: "document" | "file";
  path: string;
  direction: SyncPreviewDirection;
  action: SyncPreviewAction;
  detail: string;
  recordId?: string;
  fileId?: string;
}

export interface MdbaseSyncPreview extends MirrorInitializationPreview {
  phase: "initial" | "incremental" | "rebuild";
  entries: SyncPreviewEntry[];
  cursor: number | null;
  remoteHead: number | null;
}

export function remoteChangeEntries(
  state: MirrorState,
  events: readonly SyncChange[],
): SyncPreviewEntry[] {
  type RecordChange = Extract<SyncChange, { type: "put" | "remove" }>;
  const finalByRecord = new Map<string, RecordChange>();
  for (const event of events.filter((value): value is RecordChange => value.type === "put" || value.type === "remove")) {
    const recordId = event.type === "put" ? event.record.record_id : event.record_id;
    finalByRecord.set(recordId, event);
  }
  return [...finalByRecord.entries()]
    .flatMap(([recordId, event]): SyncPreviewEntry[] => {
      const previous = state.records[recordId];
      if (event.type === "remove") {
        if (!previous) return [];
        return [{
          kind: "document",
          path: previous?.path ?? event.previous_path,
          direction: "download",
          action: "delete",
          detail: "Hosted collection deleted this document.",
          recordId,
        }];
      }
      if (previous?.revision === event.record.revision && previous.path === event.record.path) return [];
      const action = previous == null
        ? "create"
        : previous.path !== event.record.path
          ? "rename"
          : "update";
      return [{
        kind: "document",
        path: event.record.path,
        direction: "download",
        action,
        detail: action === "rename"
          ? `Hosted collection moved this document from ${previous?.path}.`
          : `Hosted collection will ${action} this document.`,
        recordId,
      }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function localChangeEntries(
  state: MirrorState,
  documents: ReadonlyMap<string, string | null>,
  localPaths: readonly string[],
  resourcePaths: ReadonlySet<string>,
  digest: (value: string) => string,
): SyncPreviewEntry[] {
  if (state.mode === "read_only") return [];
  const result: SyncPreviewEntry[] = [];
  const managedByPath = new Map(Object.entries(state.records).map(([recordId, entry]) => [entry.path, { recordId, entry }]));
  for (const [recordId, entry] of Object.entries(state.records)) {
    const document = documents.get(entry.path);
    if (document === undefined) continue;
    if (document === null) {
      result.push({
        kind: "document",
        path: entry.path,
        direction: "upload",
        action: "delete",
        detail: "Local document was deleted.",
        recordId,
      });
    } else if (digest(document) !== entry.hash) {
      result.push({
        kind: "document",
        path: entry.path,
        direction: "upload",
        action: "update",
        detail: "Local document changed since the last sync.",
        recordId,
      });
    }
  }
  for (const path of localPaths) {
    if (resourcePaths.has(path) || managedByPath.has(path)) continue;
    result.push({
      kind: "document",
      path,
      direction: "upload",
      action: "create",
      detail: "Local document is not yet in the hosted collection.",
    });
  }
  for (const pending of state.pending ?? []) {
    if (result.some((entry) => entry.recordId === pending.mutation.record_id && entry.path === pending.local_path)) continue;
    result.push({
      kind: "document",
      path: pending.local_path,
      direction: "upload",
      action: pending.mutation.operation,
      detail: "This local change is queued for upload.",
      recordId: pending.mutation.record_id,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function remoteFileChangeEntries(
  state: MirrorState,
  events: readonly SyncChange[],
  selected: (file: CollectionFileDescriptor) => boolean,
): SyncPreviewEntry[] {
  type FileChange = Extract<SyncChange, { type: "file_put" | "file_remove" }>;
  const finalByFile = new Map<string, FileChange>();
  for (const event of events.filter((value): value is FileChange => value.type === "file_put" || value.type === "file_remove")) {
    finalByFile.set(event.type === "file_put" ? event.file.file_id : event.file_id, event);
  }
  return [...finalByFile.entries()].flatMap(([fileId, event]): SyncPreviewEntry[] => {
    const previous = state.files?.[fileId]?.file;
    if (event.type === "file_remove") {
      if (!previous) return [];
      return [{
        kind: "file",
        path: previous.path,
        direction: "download",
        action: "delete",
        detail: "Hosted collection deleted this file.",
        fileId,
      }];
    }
    if (!selected(event.file)) {
      return previous ? [{
        kind: "file",
        path: previous.path,
        direction: "download",
        action: "delete",
        detail: "This file is no longer selected for this device.",
        fileId,
      }] : [];
    }
    if (previous?.revision === event.file.revision && previous.path === event.file.path) return [];
    const action = previous == null ? "create" : previous.path !== event.file.path ? "rename" : "update";
    return [{
      kind: "file",
      path: event.file.path,
      direction: "download",
      action,
      detail: action === "rename"
        ? `Hosted collection moved this file from ${previous?.path}.`
        : `Hosted collection will ${action} this file.`,
      fileId,
    }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function localFileChangeEntries(
  state: MirrorState,
  local: ReadonlyMap<string, MirrorBinaryInfo>,
  localPaths: readonly string[],
): SyncPreviewEntry[] {
  if (state.mode === "read_only") return [];
  const result: SyncPreviewEntry[] = [];
  const untracked = new Set(localPaths);
  const missing = new Set<string>();
  for (const [fileId, entry] of Object.entries(state.files ?? {})) {
    if (local.has(entry.file.path)) untracked.delete(entry.file.path);
    else if (!state.file_conflicts?.[fileId]) missing.add(fileId);
  }
  for (const fileId of [...missing]) {
    const previous = state.files![fileId].file;
    const candidates = [...untracked].filter((path) => sameBinary(local.get(path), previous));
    if (candidates.length !== 1) continue;
    const path = candidates[0];
    result.push({
      kind: "file",
      path,
      direction: "upload",
      action: "rename",
      detail: `Move hosted file from ${previous.path}.`,
      fileId,
    });
    missing.delete(fileId);
    untracked.delete(path);
  }
  for (const [fileId, entry] of Object.entries(state.files ?? {})) {
    if (missing.has(fileId) || state.file_conflicts?.[fileId]) continue;
    const info = local.get(entry.file.path);
    if (!info || sameBinary(info, entry.file)) continue;
    result.push({
      kind: "file",
      path: entry.file.path,
      direction: "upload",
      action: "update",
      detail: "Local file changed since the last sync.",
      fileId,
    });
  }
  for (const fileId of missing) {
    result.push({
      kind: "file",
      path: state.files![fileId].file.path,
      direction: "upload",
      action: "delete",
      detail: "Local file was deleted.",
      fileId,
    });
  }
  for (const path of untracked) {
    result.push({
      kind: "file",
      path,
      direction: "upload",
      action: "create",
      detail: "Local file is not yet in the hosted collection.",
    });
  }
  for (const pending of state.pending_files ?? []) {
    const fileId = pending.operation === "upload" ? pending.file_id : pending.file_id;
    if (result.some((entry) => entry.kind === "file" && entry.path === pending.path && entry.fileId === fileId)) continue;
    result.push({
      kind: "file",
      path: pending.path,
      direction: "upload",
      action: pending.operation === "move" ? "rename" : pending.operation === "delete" ? "delete" : pending.file_id ? "update" : "create",
      detail: "This file change is queued for upload.",
      ...(fileId ? { fileId } : {}),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function flagConcurrentFileChanges(entries: readonly SyncPreviewEntry[]): SyncPreviewEntry[] {
  const downloads = entries.filter((entry) => entry.kind === "file" && entry.direction === "download");
  const uploads = entries.filter((entry) => entry.kind === "file" && entry.direction === "upload");
  const conflicted = new Set<SyncPreviewEntry>();
  const attention: SyncPreviewEntry[] = [];
  for (const download of downloads) {
    const upload = uploads.find((candidate) =>
      (download.fileId && candidate.fileId && candidate.fileId === download.fileId)
      || candidate.path === download.path,
    );
    if (!upload) continue;
    conflicted.add(download);
    conflicted.add(upload);
    attention.push({
      kind: "file",
      path: download.path,
      direction: "attention",
      action: "fix",
      detail: "Both the local and hosted file changed since the last sync. Choose a complete version after sync reports the conflict.",
      ...(download.fileId ?? upload.fileId ? { fileId: download.fileId ?? upload.fileId } : {}),
    });
  }
  return [...entries.filter((entry) => !conflicted.has(entry)), ...attention];
}

function sameBinary(
  info: MirrorBinaryInfo | undefined,
  file: Pick<CollectionFileDescriptor, "size" | "content_digest">,
): boolean {
  return info?.size === file.size && info.content_digest === file.content_digest;
}

export function summarizePreview(
  base: Omit<MdbaseSyncPreview, "download_documents" | "upload_documents" | "download_files" | "upload_files">,
): MdbaseSyncPreview {
  return {
    ...base,
    download_documents: base.entries.filter((entry) => entry.kind === "document" && entry.direction === "download").length,
    upload_documents: base.entries.filter((entry) => entry.kind === "document" && entry.direction === "upload").length,
    download_files: base.entries.filter((entry) => entry.kind === "file" && entry.direction === "download").length,
    upload_files: base.entries.filter((entry) => entry.kind === "file" && entry.direction === "upload").length,
  };
}
