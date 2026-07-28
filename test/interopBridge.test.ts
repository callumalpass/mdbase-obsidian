import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianInteropBridge } from "../src/interopBridge";
import type { EventContractArtifact } from "@callumalpass/mdbase-interop";

const eventContract: EventContractArtifact = {
  kind: "mdbase.contract",
  contract_type: "event",
  id: "example.changed",
  version: "1.0.0",
  data_schema: {
    dialect: "json-schema-2020-12",
    value: {
      type: "object",
      required: ["value"],
      additionalProperties: false,
      properties: { value: { type: "string" } },
    },
  },
};

test("the Obsidian bridge derives plugin identity and remains default deny until granted", async () => {
  let enabled = false;
  const plugin = {
    manifest: { id: "example-plugin", version: "2.3.4" },
  };
  const app = {
    plugins: {
      getPlugin: (id: string) => id === "example-plugin" ? plugin : null,
    },
  };
  const gateway = new ObsidianInteropBridge(app as never, () => enabled);
  const client = gateway.connect(plugin as never);

  assert.deepEqual(client.identity, {
    application: "example-plugin",
    implementation: "example-plugin.obsidian",
    version: "2.3.4",
  });
  await assert.rejects(
    client.registerEventSource({
      declaration_id: "events",
      contracts: [{ contract: eventContract }],
    }),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === "unauthorized",
  );

  enabled = true;
  const registration = await client.registerEventSource({
    declaration_id: "events",
    contracts: [{ contract: eventContract }],
  });
  assert.equal(registration.declaration.source.application, "example-plugin");
  assert.equal(gateway.describe().event_sources.length, 1);

  await client.dispose();
  assert.equal(gateway.describe().event_sources.length, 0);
  await gateway.dispose();
});

test("the Obsidian bridge rejects stale or fabricated plugin instances", () => {
  const active = { manifest: { id: "example-plugin", version: "1.0.0" } };
  const app = {
    plugins: {
      getPlugin: () => active,
    },
  };
  const gateway = new ObsidianInteropBridge(app as never, () => true);
  const fabricated = { manifest: { id: "example-plugin", version: "9.9.9" } };
  assert.throws(
    () => gateway.connect(fabricated as never),
    /not the active loaded instance/u,
  );
});
