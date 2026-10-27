/*
 * Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkInputFiles,
  decodeInputs,
  encodeInputs,
  inputArchive,
  INPUTS_BODY_LIMIT
} from "../dist/sandbox/docker/session-inputs.js";
import { createBrokerServer, listenUnix } from "../dist/sandbox/docker/server.js";
import { BrokerClient } from "../dist/sandbox/docker/client.js";
import { BrokerSandboxLauncher } from "../dist/sandbox/docker/broker-sandbox.js";

const MiB = 1024 * 1024;
const REF = { allocationId: "run-1-g1", tenantId: "7", runId: "1", generation: 1 };

/** Read back a ustar archive: entries with name, type, mode, size and content; checks checksums. */
function readTar(parts) {
  const archive = Buffer.concat(parts);
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("ascii")
        .replace(/\0.*$/s, "");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(parseInt(text(148, 8), 8), sum, "tar checksum");
    assert.equal(header.subarray(257, 265).toString("latin1"), "ustar\u000000");
    const size = parseInt(text(124, 12), 8);
    entries.push({
      name: text(0, 100),
      type: text(156, 1),
      mode: parseInt(text(100, 8), 8),
      size,
      data: archive.subarray(offset + 512, offset + 512 + size)
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("put inputs wire format round-trips names and bytes exactly", () => {
  const files = [
    { name: "report.pdf", data: Buffer.from("%PDF-1.7") },
    { name: "empty.bin", data: Buffer.alloc(0) },
    { name: "manifest.json", data: Buffer.from("[]\n") }
  ];
  const decoded = decodeInputs(encodeInputs(REF, files));
  assert.deepEqual(decoded.ref, REF);
  assert.deepEqual(
    decoded.files.map(file => [file.name, file.data.toString()]),
    files.map(file => [file.name, file.data.toString()])
  );
});

test("put inputs validation rejects traversal, unsafe names, duplicates and oversize", () => {
  const reject = (files, code) =>
    assert.throws(() => checkInputFiles(files), { code }, JSON.stringify(files).slice(0, 80));
  for (const name of ["../x", "a/b", "..", ".", ".hidden", "a\\b", "x\u0000y", "é", "", "x."])
    reject([{ name, size: 1 }], "INVALID_INPUTS");
  reject([], "INVALID_INPUTS");
  reject(
    [
      { name: "a.txt", size: 1 },
      { name: "A.TXT", size: 1 }
    ],
    "INVALID_INPUTS"
  );
  reject([{ name: "a.txt", size: -1 }], "INVALID_INPUTS");
  reject([{ name: "a.txt", size: 10 * MiB + 1 }], "INPUTS_LIMIT");
  reject([{ name: "manifest.json", size: 256 * 1024 + 1 }], "INPUTS_LIMIT");
  reject(
    Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, size: 9 * MiB })),
    "INPUTS_LIMIT"
  );
  reject(
    Array.from({ length: 52 }, (_, i) => ({ name: `f${i}.bin`, size: 1 })),
    "INVALID_INPUTS"
  );
  // The decoder checks the declared header and that the body matches it exactly.
  const body = encodeInputs(REF, [{ name: "a.txt", data: Buffer.from("abc") }]);
  assert.throws(() => decodeInputs(body.subarray(0, body.length - 1)), { code: "INVALID_INPUTS" });
  assert.throws(() => decodeInputs(Buffer.concat([body, Buffer.from("x")])), {
    code: "INVALID_INPUTS"
  });
  const forged = (header, data = Buffer.alloc(0)) => {
    const json = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json, data]);
  };
  assert.throws(
    () =>
      decodeInputs(
        forged({ ref: REF, files: [{ name: "../../etc/x", size: 1 }] }, Buffer.from("x"))
      ),
    { code: "INVALID_INPUTS" }
  );
  assert.throws(
    () =>
      decodeInputs(
        forged({ ref: REF, files: [{ name: "a", size: 1, mode: 4095 }] }, Buffer.from("x"))
      ),
    { code: "INVALID_SPEC" }
  );
  assert.throws(() => decodeInputs(forged({ ref: REF, files: [], path: "/" })), {
    code: "INVALID_SPEC"
  });
  assert.throws(() => decodeInputs(Buffer.from([0, 0, 0])), { code: "INVALID_INPUTS" });
});

test("the archive holds only inputs/ and regular files under it, owner 1000, private modes", () => {
  const entries = readTar(
    inputArchive(
      [
        { name: "a.txt", data: Buffer.from("x".repeat(513)) },
        { name: "manifest.json", data: Buffer.from("[]") }
      ],
      0
    )
  );
  assert.deepEqual(
    entries.map(entry => [entry.name, entry.type, entry.mode.toString(8), entry.size]),
    [
      ["inputs/", "5", "700", 0],
      ["inputs/a.txt", "0", "600", 513],
      ["inputs/manifest.json", "0", "600", 2]
    ]
  );
  assert.equal(entries[1].data.toString(), "x".repeat(513));
  assert.throws(() => inputArchive([{ name: "../a", data: Buffer.from("x") }]), {
    code: "INVALID_INPUTS"
  });
});

test("put inputs over the Broker socket: authenticated binary upload, bounded body", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "broker.sock");
  const token = "t".repeat(40);
  const received = [];
  const broker = {
    putInputs: async body => {
      const request = decodeInputs(body);
      received.push(request);
      return { ref: request.ref, files: request.files.length, bytes: 3 };
    }
  };
  const server = createBrokerServer(broker, token);
  await listenUnix(server, socket);
  t.after(() => server.close());
  const client = new BrokerClient(socket, token);
  const reply = await client.putInputs(REF, [{ name: "a.txt", data: Buffer.from("abc") }]);
  assert.deepEqual(reply, { ref: REF, files: 1, bytes: 3 });
  assert.equal(received[0].files[0].data.toString(), "abc");
  const raw = (headers, body = Buffer.alloc(0)) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: socket, method: "POST", path: "/v1/inputs", headers, agent: false },
        res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) })
          );
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  const body = encodeInputs(REF, [{ name: "a.txt", data: Buffer.from("abc") }]);
  assert.equal((await raw({ "content-type": "application/octet-stream" }, body)).status, 401);
  const auth = { authorization: `Bearer ${token}` };
  assert.deepEqual(await raw({ ...auth, "content-type": "application/json" }, body), {
    status: 415,
    body: { error: "CONTENT_TYPE" }
  });
  assert.deepEqual(
    await raw({
      ...auth,
      "content-type": "application/octet-stream",
      "content-length": String(INPUTS_BODY_LIMIT + 1)
    }),
    { status: 413, body: { error: "BODY_LIMIT" } }
  );
  const traversal = Buffer.from(body);
  traversal.write("../ab", body.indexOf("a.txt"), "ascii");
  assert.equal(
    (await raw({ ...auth, "content-type": "application/octet-stream" }, traversal)).status,
    400
  );
  assert.equal(received.length, 1);
});

test("the sandbox puts inputs after allocation and before the CLI; failure releases it", async () => {
  const now = Date.now();
  const request = {
    allocationId: "run-201-g1",
    harness: "codex",
    tenantId: "7",
    runId: "201",
    userId: "401",
    generation: 1,
    conversationId: "301",
    expiresAt: now + 600000,
    leaseExpiresAt: now + 30000,
    prompt: "Hello",
    promptFormat: "text",
    modelAlias: "gpt-test",
    toolServer: "tools",
    enabledTools: ["metadata.get_raw"],
    modelCapability: "m".repeat(43),
    toolCapability: "t".repeat(43),
    inputs: [{ name: "a.txt", data: Buffer.from("abc") }]
  };
  const calls = [];
  const broker = putInputs => ({
    status: async () => ({
      nodeId: "node-1",
      ready: true,
      managedLaunch: true,
      harnesses: ["codex"]
    }),
    allocateManaged: async spec => {
      calls.push("allocate");
      return {
        ref: {
          allocationId: spec.allocationId,
          tenantId: spec.tenantId,
          runId: spec.runId,
          generation: 1
        },
        userId: spec.userId,
        expiresAt: spec.expiresAt,
        leaseExpiresAt: spec.leaseExpiresAt,
        state: "allocating"
      };
    },
    putInputs: async (ref, files) => {
      calls.push(`put:${files.map(file => file.name).join(",")}`);
      return putInputs(ref, files);
    },
    renew: async () => ({}),
    terminate: async () => {
      calls.push("terminate");
      return {};
    }
  });
  const drivers = { codex: () => (calls.push("driver"), { dispose: async () => {} }) };
  const ok = new BrokerSandboxLauncher(
    broker(async (ref, files) => ({ ref, files: files.length })),
    "node-1",
    drivers
  );
  await ok.open(request, new AbortController().signal);
  assert.deepEqual(calls, ["allocate", "put:a.txt", "driver"]);
  calls.length = 0;
  const failing = new BrokerSandboxLauncher(
    broker(async () => {
      throw new Error("INPUTS_FAILED");
    }),
    "node-1",
    drivers
  );
  await assert.rejects(failing.open(request, new AbortController().signal), {
    message: "INPUTS_UNAVAILABLE"
  });
  assert.deepEqual(calls, ["allocate", "put:a.txt", "terminate"]);
  calls.length = 0;
  // A reply for another allocation is not trusted.
  const foreign = new BrokerSandboxLauncher(
    broker(async (ref, files) => ({ ref: { ...ref, runId: "202" }, files: files.length })),
    "node-1",
    drivers
  );
  await assert.rejects(foreign.open(request, new AbortController().signal), {
    message: "INPUTS_UNAVAILABLE"
  });
  calls.length = 0;
  // Without inputs nothing is put.
  await ok.open({ ...request, inputs: undefined }, new AbortController().signal);
  assert.deepEqual(calls, ["allocate", "driver"]);
});

test("a file-mode session reads its outputs when the Driver stops the transport, before termination empties the workspace", async () => {
  const now = Date.now();
  const calls = [];
  const collected = { files: [{ name: "a.csv", data: Buffer.from("x") }], rejected: [] };
  const broker = {
    status: async () => ({
      nodeId: "node-1",
      ready: true,
      managedLaunch: true,
      harnesses: ["codex"]
    }),
    allocateManaged: async spec => ({
      ref: {
        allocationId: spec.allocationId,
        tenantId: spec.tenantId,
        runId: spec.runId,
        generation: 1
      },
      userId: spec.userId,
      expiresAt: spec.expiresAt,
      leaseExpiresAt: spec.leaseExpiresAt,
      state: "allocating"
    }),
    putInputs: async (ref, files) => ({ ref, files: files.length }),
    getOutputs: async () => (calls.push("read"), collected),
    renew: async () => ({}),
    terminate: async () => (calls.push("terminate"), {})
  };
  let bound;
  // Like the real Drivers: the transport (and so the hook) stops when the turn ends.
  const driver = {
    dispose: async () => {
      await bound.beforeTerminate?.();
      calls.push("terminate");
      driver.stopEvidence = { state: "exited" };
    }
  };
  const launcher = new BrokerSandboxLauncher(broker, "node-1", {
    codex: binding => ((bound = binding), driver)
  });
  const request = {
    allocationId: "run-201-g1",
    harness: "codex",
    tenantId: "7",
    runId: "201",
    userId: "401",
    generation: 1,
    conversationId: "301",
    expiresAt: now + 600000,
    leaseExpiresAt: now + 30000,
    prompt: "Hello",
    promptFormat: "text",
    modelAlias: "gpt-test",
    toolServer: "tools",
    enabledTools: ["metadata.get_raw"],
    modelCapability: "m".repeat(43),
    toolCapability: "t".repeat(43),
    inputs: [{ name: "manifest.json", data: Buffer.from("[]") }]
  };
  const session = await launcher.open(request, new AbortController().signal);
  await driver.dispose();
  assert.deepEqual(await session.outputs(AbortSignal.timeout(1000)), collected);
  assert.deepEqual(
    calls,
    ["read", "terminate"],
    "read once, before termination; outputs() reuses it"
  );
  // Without inputs there is no hook and no outputs().
  const plain = await launcher.open(
    { ...request, inputs: undefined },
    new AbortController().signal
  );
  assert.equal(bound.beforeTerminate, undefined);
  assert.equal(plain.outputs, undefined);
});
