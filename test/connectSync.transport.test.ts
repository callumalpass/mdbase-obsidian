import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CollectionFileDescriptor } from "@mdbase-dev/connect-protocol";
import { ObsidianSyncTransport, resilientRequestUrl } from "../src/connectSync";

const authorityId = "11111111-1111-4111-8111-111111111111";
const syncUrl = `https://connect.example/v1/authorities/${authorityId}/sync`;

function response(status: number, json: unknown = {}, bytes = new ArrayBuffer(0), headers: Record<string, string> = {}) {
  return { status, json, text: JSON.stringify(json), arrayBuffer: bytes, headers };
}

function descriptor(path: string, bytes: Uint8Array): CollectionFileDescriptor {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    path,
    revision: `file:${digest}`,
    content_digest: `sha256:${digest}`,
    size: bytes.byteLength,
    media_class: "image",
    media_type: "image/png",
    modified_at: "2026-08-05T00:00:00.000Z",
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of source) parts.push(...chunk);
  return Uint8Array.from(parts);
}

test("HTTP adapter falls back to fetch only when Obsidian's native bridge fails", async () => {
  let fetchCalls = 0;
  const result = await resilientRequestUrl({
    url: "https://connect.example/probe",
    method: "POST",
    headers: { "x-probe": "one" },
    contentType: "application/json",
    body: JSON.stringify({ exact: true }),
    throw: false,
  }, async () => {
    throw new Error("net::ERR_FAILED");
  }, async (_input, init) => {
    fetchCalls += 1;
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    assert.equal(init?.body, JSON.stringify({ exact: true }));
    return new Response(JSON.stringify({ recovered: true }), {
      status: 201,
      headers: { "content-type": "application/json", "x-result": "fallback" },
    });
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.status, 201);
  assert.deepEqual(result.json, { recovered: true });
  assert.equal(result.headers["x-result"], "fallback");
  assert.equal(new TextDecoder().decode(result.arrayBuffer), result.text);

  fetchCalls = 0;
  const native = await resilientRequestUrl({ url: "https://connect.example/probe", throw: false }, async () =>
    response(503, { error: { code: "busy" } }) as never, async () => {
      fetchCalls += 1;
      return new Response();
    });
  assert.equal(native.status, 503);
  assert.equal(fetchCalls, 0);
});

test("Obsidian HTTP transport downloads bounded binary parts and cleans up the transfer", async () => {
  const bytes = Uint8Array.of(0, 1, 2, 3, 254, 255);
  const file = descriptor("Media/download.png", bytes);
  let transferId = "";
  let cleaned = false;
  const send = async (request: { url: string; method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> }) => {
    if (request.url.endsWith("/files/downloads")) {
      transferId = JSON.parse(String(request.body)).transfer_id as string;
      return response(200, {
        protocol_version: 1,
        type: "file_transfer",
        transfer_id: transferId,
        direction: "download",
        protection: "transport_tls",
        strategy: { kind: "object_ranges", part_size: 4 },
        total_size: bytes.byteLength,
        expires_at: "2026-08-05T01:00:00.000Z",
        received: [],
      });
    }
    if (request.url.endsWith(`/downloads/${transferId}/parts/0`)) {
      return response(200, undefined, bytes.slice(0, 4).buffer, { "Content-Length": "4" });
    }
    if (request.url.endsWith(`/downloads/${transferId}/parts/1`)) {
      return response(200, undefined, bytes.slice(4).buffer, { "content-length": "2" });
    }
    if (request.url.endsWith(`/transfers/${transferId}`) && request.method === "DELETE") {
      cleaned = true;
      return response(204);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const transport = new ObsidianSyncTransport(syncUrl, "secret-token", send as never);
  assert.deepEqual(await collect(transport.downloadFile(file)), bytes);
  assert.equal(cleaned, true);
});

test("Obsidian HTTP transport uploads exact multipart bytes without forwarding credentials", async () => {
  const bytes = Uint8Array.of(9, 8, 7, 6, 5);
  const file = descriptor("Media/upload.png", bytes);
  const transferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const uploaded: Uint8Array[] = [];
  const objectHeaders: Record<string, string>[] = [];
  const send = async (request: { url: string; method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> }) => {
    if (request.url.endsWith("/files/uploads")) {
      return response(200, {
        protocol_version: 1,
        type: "file_transfer",
        transfer_id: transferId,
        direction: "upload",
        protection: "transport_tls",
        strategy: { kind: "object_multipart", part_size: 3 },
        total_size: bytes.byteLength,
        expires_at: "2026-08-05T01:00:00.000Z",
        received: [],
        uploaded_parts: [],
      });
    }
    if (request.url.endsWith(`/uploads/${transferId}/parts`)) {
      const part = JSON.parse(String(request.body)) as { part_number: number; content_length: number };
      const index = part.part_number - 1;
      return response(200, {
        protocol_version: 1,
        type: "file_part",
        transfer_id: transferId,
        part_index: index,
        offset: index * 3,
        content_length: part.content_length,
        method: "PUT",
        url: `https://objects.example/part/${index}`,
        headers: {
          authorization: "must-not-forward",
          cookie: "must-not-forward",
          host: "must-not-forward",
          "x-object-token": `part-${index}`,
        },
        expires_at: "2026-08-05T01:00:00.000Z",
      });
    }
    if (request.url.startsWith("https://objects.example/part/")) {
      uploaded.push(new Uint8Array(request.body as ArrayBuffer));
      objectHeaders.push(request.headers ?? {});
      return response(200, {}, new ArrayBuffer(0), { etag: `etag-${uploaded.length}` });
    }
    if (request.url.endsWith(`/uploads/${transferId}/commit`)) {
      const body = JSON.parse(String(request.body)) as { parts: Array<{ part_number: number; etag: string }> };
      assert.deepEqual(body.parts, [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
      ]);
      return response(200, {
        protocol_version: 1,
        type: "file_upload_committed",
        transfer_id: transferId,
        file,
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const transport = new ObsidianSyncTransport(syncUrl, "secret-token", send as never);
  const receipt = await transport.uploadFile({
    protocol_version: 1,
    type: "open_file_upload",
    transfer_id: transferId,
    path: file.path,
    size: file.size,
    content_digest: file.content_digest,
    media_type: file.media_type,
  }, (async function* () {
    yield bytes.subarray(0, 1);
    yield bytes.subarray(1, 4);
    yield bytes.subarray(4);
  })());
  assert.equal(receipt.file.path, file.path);
  assert.deepEqual(Uint8Array.from(uploaded.flatMap((part) => [...part])), bytes);
  assert.deepEqual(objectHeaders, [
    { "x-object-token": "part-0" },
    { "x-object-token": "part-1" },
  ]);
});
