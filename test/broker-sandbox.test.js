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
import { BrokerSandboxLauncher } from "../dist/sandbox/docker/broker-sandbox.js";

const capability = c => c.repeat(43);
function request(changes = {}) {
  const now = Date.now();
  return {
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
    modelCapability: capability("m"),
    toolCapability: capability("t"),
    ...changes
  };
}
function broker(changes = {}) {
  const calls = [];
  return {
    calls,
    status: async () => ({
      nodeId: "node-1",
      ready: true,
      managedLaunch: true,
      harnesses: ["codex"]
    }),
    allocateManaged: async (spec, authorization) => {
      calls.push({ op: "allocate", spec, authorization });
      return {
        ref: {
          allocationId: spec.allocationId,
          tenantId: spec.tenantId,
          runId: spec.runId,
          generation: spec.generation
        },
        userId: spec.userId,
        expiresAt: spec.expiresAt,
        leaseExpiresAt: spec.leaseExpiresAt,
        state: "allocating"
      };
    },
    renew: async value => {
      calls.push({ op: "renew", value });
      return { leaseExpiresAt: value.requestedExpiresAt };
    },
    terminate: async ref => {
      calls.push({ op: "terminate", ref });
      return {};
    },
    ...changes
  };
}

test("allocation carries only the frozen prompt and scoped capabilities, never raw credentials", async () => {
  const fake = broker();
  const bindings = [];
  const driver = {
    stopEvidence: undefined,
    dispose: async () => (driver.stopEvidence = { state: "exited" })
  };
  const launcher = new BrokerSandboxLauncher(fake, "node-1", {
    codex: binding => {
      bindings.push(binding);
      return driver;
    }
  });
  const r = request({
    promptFormat: "workspace-context-v1",
    prompt: JSON.stringify({ version: 1, prompt: "p", ui_context: { a: 1 } })
  });
  const session = await launcher.open(r, new AbortController().signal);
  const { spec, authorization } = fake.calls[0];
  assert.equal(spec.schemaVersion, 2);
  assert.equal(spec.harness, "codex");
  assert.equal(spec.promptFormat, "workspace-context-v1");
  assert.deepEqual(spec.session, { taskId: "301", memberId: "401" });
  assert.deepEqual(authorization, {
    modelAlias: "gpt-test",
    toolServer: "tools",
    toolServer: "tools",
    enabledTools: ["metadata.get_raw"],
    model: { value: capability("m"), expiresAt: r.expiresAt },
    tool: { value: capability("t"), expiresAt: r.expiresAt }
  });
  // The allocation envelope has exactly these fields; nothing else can carry a secret.
  assert.deepEqual(Object.keys(fake.calls[0]).sort(), ["authorization", "op", "spec"]);
  assert.deepEqual(bindings[0], {
    ref: { allocationId: "run-201-g1", tenantId: "7", runId: "201", generation: 1 },
    userId: "401",
    expiresAt: r.expiresAt,
    nodeId: "node-1"
  });

  // Renewal follows the Engine lease in bounded steps and never exceeds the deadline.
  await session.renew(Date.now() + 31000, AbortSignal.timeout(1000));
  assert.equal(fake.calls.filter(c => c.op === "renew").length, 0);
  const target = Date.now() + 50000;
  await session.renew(target, AbortSignal.timeout(1000));
  const renewal = fake.calls.find(c => c.op === "renew").value;
  assert.equal(renewal.expectedExpiresAt, r.leaseExpiresAt);
  assert.ok(renewal.requestedExpiresAt <= target);
  assert.equal(await session.close(), "stopped");
});

test("failed or unverifiable allocation is terminated before reporting failure", async () => {
  const fake = broker({
    allocateManaged: async spec => ({ ref: { allocationId: spec.allocationId }, state: "running" })
  });
  const launcher = new BrokerSandboxLauncher(fake, "node-1", {
    codex: () => {
      throw new Error("must not create a driver");
    }
  });
  await assert.rejects(
    launcher.open(request(), new AbortController().signal),
    /SANDBOX_UNAVAILABLE/
  );
  assert.deepEqual(fake.calls.at(-1), {
    op: "terminate",
    ref: { allocationId: "run-201-g1", tenantId: "7", runId: "201", generation: 1 }
  });
  const wrongNode = new BrokerSandboxLauncher(broker(), "node-2", { codex: () => ({}) });
  await assert.rejects(
    wrongNode.open(request(), new AbortController().signal),
    /BROKER_UNAVAILABLE/
  );
});

test("a Harness without a Driver here or an image on the Broker fails before allocation", async () => {
  const fake = broker();
  const launcher = new BrokerSandboxLauncher(fake, "node-1", {
    codex: () => assert.fail("no driver for this Run"),
    "claude-code": () => assert.fail("no image for this Run")
  });
  for (const harness of ["opencode", "claude-code"])
    await assert.rejects(
      launcher.open(request({ harness }), new AbortController().signal),
      /^Error: HARNESS_UNAVAILABLE$/
    );
  assert.deepEqual(fake.calls, [], "nothing was allocated");
});

test("a renewal whose reply was lost is retried with the identical request", async () => {
  const recorded = { lease: undefined };
  let drop = true;
  const fake = broker({
    renew: async value => {
      fake.calls.push({ op: "renew", value });
      // Broker semantics: accept when current == expected or current == requested (replay)
      if (recorded.lease !== value.expectedExpiresAt && recorded.lease !== value.requestedExpiresAt)
        throw new Error("RENEWAL_CONFLICT");
      recorded.lease = value.requestedExpiresAt;
      if (drop) {
        drop = false;
        throw new Error("REPLY_LOST");
      }
      return { leaseExpiresAt: value.requestedExpiresAt };
    }
  });
  const driver = { dispose: async () => (driver.stopEvidence = { state: "exited" }) };
  const launcher = new BrokerSandboxLauncher(fake, "node-1", { codex: () => driver });
  const r = request({ leaseExpiresAt: Date.now() + 10_000 });
  const session = await launcher.open(r, new AbortController().signal);
  recorded.lease = r.leaseExpiresAt;
  const signal = new AbortController().signal;
  await assert.rejects(session.renew(Date.now() + 40_000, signal));
  await session.renew(Date.now() + 50_000, signal);
  const renewals = fake.calls.filter(c => c.op === "renew").map(c => c.value);
  assert.equal(renewals.length, 2);
  assert.deepEqual(renewals[1], renewals[0], "the retry must repeat the unconfirmed request");
  await session.renew(Date.now() + 54_000, signal);
  const third = fake.calls.filter(c => c.op === "renew")[2]?.value;
  if (third) assert.equal(third.expectedExpiresAt, renewals[0].requestedExpiresAt);
});

test("a stop retry asks the Broker again instead of returning the Driver's cached result", async () => {
  let receipt = {};
  const fake = broker({
    terminate: async ref => {
      fake.calls.push({ op: "terminate", ref });
      return receipt;
    }
  });
  let disposals = 0;
  // A Driver whose transport stop failed once; it caches that result like the Codex adapter.
  const driver = {
    dispose: async () => {
      disposals++;
      driver.stopEvidence = { state: "unknown" };
    }
  };
  const launcher = new BrokerSandboxLauncher(fake, "node-1", { codex: () => driver });
  const r = request();
  const session = await launcher.open(r, new AbortController().signal);
  assert.equal(await session.close(), "unknown");
  assert.equal(fake.calls.filter(c => c.op === "terminate").length, 0);

  // An unverifiable receipt stays unknown.
  assert.equal(await session.close(), "unknown");
  const ref = { allocationId: "run-201-g1", tenantId: "7", runId: "201", generation: 1 };
  receipt = { ref, userId: "401", expiresAt: r.expiresAt, state: "terminated" };
  assert.equal(await session.close(), "stopped");
  assert.equal(disposals, 1, "the Driver is disposed once");
  const terminations = fake.calls.filter(c => c.op === "terminate");
  assert.equal(terminations.length, 2);
  assert.deepEqual(terminations[1].ref, ref);
  // Confirmed: later calls do not touch the Broker again.
  assert.equal(await session.close(), "stopped");
  assert.equal(fake.calls.filter(c => c.op === "terminate").length, 2);
});
