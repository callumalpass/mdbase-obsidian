import type { App, Plugin } from "obsidian";
import {
  InMemoryInteropBridge,
  type BridgeDescription,
  type InteropClient,
  type TransportCapabilities,
} from "@callumalpass/mdbase-interop";

type PluginManager = {
  getPlugin(id: string): unknown;
};

export interface MdbaseObsidianInteropApi {
  readonly profileVersion: "0.1";
  readonly transport: TransportCapabilities;
  connect(plugin: Plugin): InteropClient;
  describe(): BridgeDescription;
}

export class ObsidianInteropBridge implements MdbaseObsidianInteropApi {
  readonly profileVersion = "0.1" as const;
  readonly transport: TransportCapabilities;
  private readonly bridge: InMemoryInteropBridge;

  constructor(
    private readonly app: App,
    enabled: () => boolean,
  ) {
    this.bridge = new InMemoryInteropBridge({
      authorize: () => enabled(),
      transport: {
        delivery: ["ephemeral"],
        ordering: ["none"],
        cancellation: true,
        deadlines: true,
        provider_discovery: true,
        request_deduplication: true,
        cross_process_identity: false,
      },
      onDiagnostic: (diagnostic) => {
        const log = diagnostic.severity === "error" ? console.error : console.warn;
        log(`[mdbase/interop] ${diagnostic.code}: ${diagnostic.message}`, diagnostic.cause ?? "");
      },
    });
    this.transport = this.bridge.describe().transport;
  }

  connect(plugin: Plugin): InteropClient {
    const id = plugin.manifest?.id;
    const version = plugin.manifest?.version;
    if (!id || !version) {
      throw new Error("Only a loaded Obsidian plugin with manifest identity can connect to mdbase interop.");
    }
    const plugins = (this.app as App & { plugins?: PluginManager }).plugins;
    if (!plugins || plugins.getPlugin(id) !== plugin) {
      throw new Error(`Obsidian plugin ${id} is not the active loaded instance.`);
    }
    return this.bridge.connect({
      application: id,
      implementation: `${id}.obsidian`,
      version,
    });
  }

  describe(): BridgeDescription {
    return this.bridge.describe();
  }

  dispose(): Promise<void> {
    return this.bridge.dispose();
  }
}
