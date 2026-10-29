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
import { createManagedRuntime } from "../dist/runtime/managed.js";

test("managed composition rejects invalid catalogs before Broker IO and releases owned resources", async () => {
  const options = {
    concurrency: 1,
    controlPlane: { controlTools: [{ name: "echo" }] },
    tools: { provider: { tools: [{ alias: "echo" }] }, enabled: ["echo"] },
    broker: { socket: "/must-not-connect", token: "test", nodeId: "test" }
  };
  const closed = [];
  await assert.rejects(
    createManagedRuntime({
      ...options,
      resources: [
        {
          close() {
            closed.push("first");
          }
        },
        {
          close() {
            closed.push("second");
            throw Error("CLEANUP_FAILED");
          }
        }
      ]
    }),
    error =>
      error instanceof AggregateError &&
      error.errors[0].message === "INVALID_MANAGED_TOOLS" &&
      error.errors[1].message === "CLEANUP_FAILED"
  );
  assert.deepEqual(closed, ["second", "first"]);
  await assert.rejects(
    createManagedRuntime({ ...options, harnesses: [] }),
    /INVALID_MANAGED_HARNESSES/
  );
  await assert.rejects(
    createManagedRuntime({ ...options, concurrency: 0 }),
    /INVALID_RUNTIME_CONCURRENCY/
  );
});

test("configuration rejection also releases owned resources in reverse order and retains cleanup errors", async () => {
  const order = [];
  await assert.rejects(
    createRuntime({
      controlPlane: control,
      sandbox,
      credentials: new RunCredentialRegistry(),
      concurrency: 0,
      lane: { runtimeId: "test", lanes: ["test"], enabledTools: ["example.read"] },
      resources: [
        {
          close() {
            order.push(1);
          }
        },
        {
          close() {
            order.push(2);
            throw Error("CLOSE_FAILED");
          }
        }
      ]
    }),
    error =>
      error instanceof AggregateError &&
      error.errors[0].message === "INVALID_RUNTIME_CONCURRENCY" &&
      error.errors[1].message === "CLOSE_FAILED"
  );
  assert.deepEqual(order, [2, 1]);
});

test("multiple failed lanes preserve all errors and close shared resources only once", async () => {
  let id = 0,
    closed = 0;
  const runtime = await createRuntime({
    controlPlane: {
      ...control,
      async claim() {
        return [{}];
      },
      readLease() {
        throw Error("LANE_" + ++id);
      }
    },
    sandbox,
    credentials: new RunCredentialRegistry(),
    concurrency: 2,
    lane: { runtimeId: "test", lanes: ["test"], enabledTools: ["example.read"] },
    resources: [
      {
        close() {
          closed++;
        }
      }
    ]
  });
  await assert.rejects(
    runtime.done,
    error =>
      error instanceof AggregateError &&
      error.errors
        .map(value => value.message)
        .sort()
        .join() === "LANE_1,LANE_2"
  );
  await assert.rejects(runtime.close(), /RUNTIME_LANES_FAILED/);
  assert.equal(closed, 1);
});

test("bind failure retains cleanup errors as well as the original socket failure", async t => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  await assert.rejects(
    createRuntime({
      controlPlane: control,
      sandbox,
      credentials: new RunCredentialRegistry(),
      concurrency: 1,
      lane: { runtimeId: "test", lanes: ["test"], enabledTools: ["example.read"] },
      endpoints: [
        { server: http.createServer(), bind: "127.0.0.1", port: occupied.address().port }
      ],
      resources: [
        {
          close() {
            throw Error("CLEANUP_FAILED");
          }
        }
      ]
    }),
    error =>
      error instanceof AggregateError &&
      error.errors[0].code === "EADDRINUSE" &&
      error.errors[1].message === "CLEANUP_FAILED"
  );
});

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

test("invalid lane configuration closes composition resources", async () => {
  let closed = 0;
  await assert.rejects(
    createRuntime({
      controlPlane: control,
      sandbox,
      credentials: new RunCredentialRegistry(),
      concurrency: 1,
      lane: { runtimeId: "runtime-test", lanes: ["test"], enabledTools: [] },
      resources: [{ close: () => closed++ }]
    }),
    /INVALID_LANE_CONFIGURATION/
  );
  assert.equal(closed, 1);
});

test("one failed lane stops its peers before shared resources close", async () => {
  let claims = 0;
  const order = [];
  const failingControl = {
    ...control,
    claim(_request, signal) {
      claims++;
      if (claims === 1) return Promise.resolve([{}]);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    readLease() {
      throw new Error("ADAPTER_BUG");
    }
  };
  const runtime = await createRuntime({
    controlPlane: failingControl,
    sandbox,
    credentials: new RunCredentialRegistry(),
    concurrency: 2,
    lane: { runtimeId: "runtime-test", lanes: ["test"], enabledTools: ["example.read"] },
    observeLane: index => event => {
      if (event.state === "stopped") order.push(`stopped-${index}`);
    },
    resources: [{ close: () => order.push("closed") }]
  });

  await assert.rejects(runtime.done, /ADAPTER_BUG/);
  assert.equal(order.at(-1), "closed");
  assert.deepEqual(order.slice(0, -1).sort(), ["stopped-1"]);
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
