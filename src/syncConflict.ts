import type { MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { ConnectSyncController } from "./connectSync";
import type { MdbaseSyncPreview } from "./syncPreview";

export interface ResolvedConflictProjection {
  status: MirrorStatus;
  preview: MdbaseSyncPreview;
}

type ConflictProjectionController = Pick<
  ConnectSyncController,
  "preview" | "resolveConflict"
>;

export async function resolveConflictAndRefresh(
  controller: ConflictProjectionController,
  objectId: string,
  decisionId: string,
  resolution: "local" | "remote",
): Promise<ResolvedConflictProjection> {
  const status = await controller.resolveConflict(objectId, decisionId, resolution);
  const preview = await controller.preview();
  return { status, preview };
}
