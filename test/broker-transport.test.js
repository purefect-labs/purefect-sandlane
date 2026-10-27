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
import { BrokerHarnessTransport } from "../dist/sandbox/docker/broker-transport.js";

const binding = () => ({
  ref: { allocationId: "a", tenantId: "t", runId: "r", generation: 1 },
  userId: "u",
  expiresAt: Date.now() + 10000,
  nodeId: "node"
});

test("channel EOF is a fault, not process or sandbox stop evidence", async () => {
  const b = binding();
  let faults = 0,
    exits = 0;
  const broker = {
    status: async () => ({ nodeId: "node", ready: true }),
    openChannel: async () => ({
      output: (async function* () {})(),
      write: async () => {},
      close() {}
    }),
    terminate: async () => {
      throw Error("private daemon fault");
    }
  };
  const transport = new BrokerHarnessTransport(broker, b);
  await transport.start({ stdout() {}, fault: () => faults++, exited: () => exits++ });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(faults, 1);
  assert.equal(exits, 0);
  assert.deepEqual(await transport.stop(), { state: "unknown" });
});

test("stop before connect still removes only the bound allocation and permanently fences start", async () => {
  const b = binding();
  let stops = 0;
  const broker = {
    status: async () => ({ nodeId: "node" }),
    openChannel: async () => {
      throw Error("must not open");
    },
    terminate: async ref => {
      assert.deepEqual(ref, b.ref);
      stops++;
      return {
        ref,
        userId: "cancelled-before-start",
        expiresAt: 0,
        digest: "0".repeat(64),
        state: "terminated"
      };
    }
  };
  const transport = new BrokerHarnessTransport(broker, b);
  assert.equal((await transport.stop()).state, "exited");
  assert.equal((await transport.stop()).state, "exited");
  assert.equal(stops, 1);
  await assert.rejects(transport.start({}), /ALREADY_USED/);
});

test("foreign node or receipt cannot be accepted as stop evidence", async () => {
  const b = binding();
  const foreignNode = new BrokerHarnessTransport(
    {
      status: async () => ({ nodeId: "other" }),
      terminate: async () => {
        throw Error("must not call");
      }
    },
    b
  );
  assert.deepEqual(await foreignNode.stop(), { state: "unknown" });
  const foreignReceipt = new BrokerHarnessTransport(
    {
      status: async () => ({ nodeId: "node" }),
      terminate: async () => ({
        ref: { ...b.ref, tenantId: "other" },
        state: "terminated",
        userId: b.userId,
        expiresAt: b.expiresAt
      })
    },
    b
  );
  assert.deepEqual(await foreignReceipt.stop(), { state: "unknown" });
});

test("stop runs the binding's hook once, before terminating; a failing hook never changes the stop", async () => {
  const calls = [];
  const receipt = ref => ({
    ref,
    userId: "cancelled-before-start",
    expiresAt: 0,
    digest: "0".repeat(64),
    state: "terminated"
  });
  const broker = {
    status: async () => ({ nodeId: "node" }),
    openChannel: async () => {
      throw Error("must not open");
    },
    terminate: async ref => (calls.push("terminate"), receipt(ref))
  };
  const reading = new BrokerHarnessTransport(broker, {
    ...binding(),
    beforeTerminate: async () => calls.push("read outputs")
  });
  assert.equal((await reading.stop()).state, "exited");
  assert.equal((await reading.stop()).state, "exited");
  assert.deepEqual(calls, ["read outputs", "terminate"]);
  calls.length = 0;
  const failing = new BrokerHarnessTransport(broker, {
    ...binding(),
    beforeTerminate: async () => {
      throw Error("OUTPUTS_FAILED");
    }
  });
  assert.equal((await failing.stop()).state, "exited");
  assert.deepEqual(calls, ["terminate"]);
});

test("the hook runs while the CLI channel is still open: its end makes the Broker terminate", async () => {
  const calls = [];
  const broker = {
    status: async () => ({ nodeId: "node", ready: true }),
    openChannel: async () => ({
      output: (async function* () {
        await new Promise(resolve => setTimeout(resolve, 50));
      })(),
      write: async () => {},
      close: () => calls.push("close channel")
    }),
    terminate: async ref => (
      calls.push("terminate"),
      {
        ref,
        userId: "cancelled-before-start",
        expiresAt: 0,
        digest: "0".repeat(64),
        state: "terminated"
      }
    )
  };
  const transport = new BrokerHarnessTransport(broker, {
    ...binding(),
    beforeTerminate: async () => calls.push("read outputs")
  });
  await transport.start({ stdout() {}, fault() {}, exited() {} });
  await transport.stop();
  assert.deepEqual(calls.slice(0, 3), ["read outputs", "close channel", "terminate"]);
});
