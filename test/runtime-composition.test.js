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
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { createRuntime } from "../dist/runtime/runtime.js";

const control = {
  claim(_request, signal) {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  },
  readLease() {
    return undefined;
  },
  async sync() {
    throw new Error("UNUSED");
  },
  async complete() {
    throw new Error("UNUSED");
  }
};

const sandbox = {
  capabilities: { isolation: "container", sessionReuse: false, channels: ["stdio"] },
  async open() {
    throw new Error("UNUSED");
  }
};

test("generic Runtime owns endpoints, lanes and resources without importing an application plugin", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  let closed = 0;
  const states = [];
  const logs = [];
  const runtime = await createRuntime({
    controlPlane: control,
    sandbox,
    credentials: new RunCredentialRegistry(),
    concurrency: 2,
    lane: {
      runtimeId: "runtime-test",
      lanes: ["test"],
      enabledTools: ["example.read"],
      claimWaitMs: 0
    },
    endpoints: [{ server, bind: "127.0.0.1", port: 0 }],
    resources: [{ close: async () => closed++ }],
    observeLane: index => event => states.push({ index, ...event }),
    log: (code, fields) => logs.push({ code, ...fields })
  });

  assert.equal(server.listening, true);
  assert.deepEqual(logs, [{ code: "RUNTIME_STARTED", lanes: 2 }]);
  await runtime.close();
  await runtime.close();
  assert.equal(server.listening, false);
  assert.equal(closed, 1);
  assert.deepEqual(
    states.filter(event => event.state === "stopped").map(event => event.index),
    [0, 1]
  );
});

test("invalid generic composition fails before opening an endpoint", async () => {
  const server = http.createServer();
  await assert.rejects(
    createRuntime({
      controlPlane: control,
      sandbox,
      credentials: new RunCredentialRegistry(),
      concurrency: 0,
      lane: { runtimeId: "runtime-test", lanes: ["test"], enabledTools: ["example.read"] },
      endpoints: [{ server, bind: "127.0.0.1", port: 0 }]
    }),
    /INVALID_RUNTIME_CONCURRENCY/
  );
  assert.equal(server.listening, false);
});

test("endpoint startup failure closes earlier endpoints and composition resources", async t => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const first = http.createServer();
  const conflicting = http.createServer();
  let closed = 0;

  await assert.rejects(
    createRuntime({
      controlPlane: control,
      sandbox,
      credentials: new RunCredentialRegistry(),
      concurrency: 1,
      lane: { runtimeId: "runtime-test", lanes: ["test"], enabledTools: ["example.read"] },
      endpoints: [
        { server: first, bind: "127.0.0.1", port: 0 },
        { server: conflicting, bind: "127.0.0.1", port: address.port }
      ],
      resources: [{ close: () => closed++ }]
    }),
    error => error?.code === "EADDRINUSE"
  );
  assert.equal(first.listening, false);
  assert.equal(closed, 1);
});
