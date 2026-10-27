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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { SandboxBroker } from "../dist/sandbox/docker/lifecycle.js";
import { BrokerError, parseRunSpec } from "../dist/sandbox/docker/contracts.js";
import { createBrokerServer } from "../dist/sandbox/docker/server.js";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { codexLauncher } from "../dist/harness/codex/codex-managed-config.js";
import { claudeCodeLauncher } from "../dist/harness/claude-code/claude-code-launcher.js";
import { BrokerClient } from "../dist/sandbox/docker/client.js";
import { listenUnix } from "../dist/sandbox/docker/server.js";
import { openBrokerChannel } from "../dist/sandbox/docker/channel-client.js";

class FakeEngine {
  containers = new Map();
  calls = [];
  lostCreate = false;
  unavailable = false;
  async request(method, url, body) {
    this.calls.push({ method, url, body });
    if (this.unavailable) throw new Error("daemon unreachable");
    if (url.startsWith("/networks?")) return [];
    if (url.startsWith("/containers/json?")) return [...this.containers.values()];
    if (url.startsWith("/containers/create?")) {
      const name = new URL(`http://docker${url}`).searchParams.get("name");
      const id = randomBytes(32).toString("hex");
      this.containers.set(name, { Id: id, Config: body, State: { Running: false }, output: "" });
      if (this.lostCreate) throw new Error("create response lost");
      return { Id: id };
    }
    const key = url.split("/")[2]?.split("?")[0];
    const entry = [...this.containers.entries()].find(([name, c]) => name === key || c.Id === key);
    if (!entry) throw new BrokerError("ENGINE_FAILURE", 404, "not found");
    const [name, c] = entry;
    if (url.endsWith("/json")) return c;
    if (url.endsWith("/start")) {
      c.State.Running = true;
      return null;
    }
    if (method === "DELETE") {
      this.containers.delete(name);
      return null;
    }
    throw new Error("unexpected Engine request");
  }
  async attach() {
    return { output: (async function* () {})(), write: async () => {}, close() {} };
  }
}
function spec(overrides = {}) {
  return {
    schemaVersion: 2,
    harness: "codex",
    allocationId: "alloc-a",
    tenantId: "tenant-a",
    userId: "user-a",
    runId: "run-a",
    generation: 1,
    expiresAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() + 30_000,
    prompt: "offline test",
    ...overrides
  };
}
/** Allocate and attach: the CLI container starts only once its channel is open. */
async function started(broker, input) {
  const allocation = await broker.allocate(input);
  await broker.openChannel(allocation.ref, new AbortController().signal);
  return broker.inspect(allocation.ref);
}
async function setup(t, clock = Date.now, harnesses = undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-broker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const config = {
    nodeId: "node-test",
    harnesses: harnesses ?? {
      codex: { image: `test/runner@sha256:${"a".repeat(64)}`, launcher: codexLauncher }
    },
    stateDir: root,
    maxConcurrent: 5,
    perTenant: 2,
    labelPrefix: "test.sandlane"
  };
  const broker = new SandboxBroker(engine, config, clock);
  await broker.init();
  return { root, engine, config, broker };
}

test("interactive allocations wait for one authorized channel and reject foreign, repeated or expired attachments", async t => {
  let now = Date.now();
  const f = await setup(t, () => now);
  let attachments = 0;
  f.engine.attach = async () => {
    attachments++;
    return { output: (async function* () {})(), write: async () => {}, close() {} };
  };
  const input = spec({ leaseExpiresAt: now + 10000 });
  const created = await f.broker.allocate(input);
  assert.equal(created.state, "allocating");
  assert.equal(f.engine.calls.filter(call => call.url.endsWith("/start")).length, 0);
  const container = [...f.engine.containers.values()][0];
  assert.deepEqual(container.Config.Entrypoint, ["/usr/local/bin/codex"]);
  assert.equal(container.Config.OpenStdin, true);
  assert.deepEqual(container.Config.Cmd, ["app-server"]);
  assert.ok(container.Config.Env.includes("CODEX_HOME=/home/runner/.codex"));
  await f.broker.reconcile();
  assert.equal(f.engine.containers.size, 1);
  await assert.rejects(
    f.broker.openChannel({ ...created.ref, tenantId: "other" }, new AbortController().signal)
  );
  assert.equal(attachments, 0);
  await f.broker.openChannel(created.ref, new AbortController().signal);
  assert.equal((await f.broker.inspect(created.ref)).channelOpened, true);
  await assert.rejects(f.broker.openChannel(created.ref, new AbortController().signal));
  assert.equal(attachments, 1);
  now += 11000;
  await f.broker.reconcile();
  assert.equal(f.engine.containers.size, 0);
  await assert.rejects(f.broker.openChannel(created.ref, new AbortController().signal));
});

test("authenticated Unix byte channel exchanges CLI bytes and disconnect triggers independent cleanup", async t => {
  const f = await setup(t);
  const output = new PassThrough();
  f.engine.attach = async () => ({
    output,
    write: async bytes => {
      output.write(bytes);
    },
    close: () => output.destroy()
  });
  const created = await f.broker.allocate(spec({ leaseExpiresAt: Date.now() + 20000 }));
  const token = randomBytes(32).toString("base64url");
  const server = createBrokerServer(f.broker, token);
  const socket = path.join(f.root, "channel.sock");
  await listenUnix(server, socket);
  let channel;
  try {
    const signal = new AbortController().signal;
    await assert.rejects(
      openBrokerChannel(socket, "x".repeat(43), created.ref, Date.now() + 10000, signal)
    );
    await assert.rejects(
      openBrokerChannel(
        socket,
        token,
        { ...created.ref, runId: "other" },
        Date.now() + 10000,
        signal
      )
    );
    assert.equal(f.engine.calls.filter(call => call.url.endsWith("/start")).length, 0);
    channel = await openBrokerChannel(socket, token, created.ref, Date.now() + 10000, signal);
    const reader = channel.output[Symbol.asyncIterator]();
    await channel.write(Buffer.from("中文😀\n"));
    assert.equal((await reader.next()).value.toString(), "中文😀\n");
    await assert.rejects(openBrokerChannel(socket, token, created.ref, Date.now() + 10000, signal));
    await assert.rejects(channel.write(Buffer.alloc(128 * 1024 + 1)));
    channel.close();
    for (let attempt = 0; attempt < 100 && f.engine.containers.size; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.engine.containers.size, 0);
    assert.equal((await f.broker.inspect(created.ref)).state, "terminated");
    await reader.return();
  } finally {
    channel?.close();
    await f.broker.shutdown();
    await new Promise(resolve => server.close(resolve));
  }
});

test("interactive attach expiry cleans up without starting a late CLI", async t => {
  let now = Date.now();
  const f = await setup(t, () => now);
  let closed = false;
  f.engine.attach = async () => {
    now += 11000;
    return {
      output: (async function* () {})(),
      write: async () => {},
      close: () => {
        closed = true;
      }
    };
  };
  const created = await f.broker.allocate(spec({ leaseExpiresAt: now + 10000 }));
  await assert.rejects(f.broker.openChannel(created.ref, new AbortController().signal), {
    code: "CHANNEL_UNAVAILABLE"
  });
  assert.equal(closed, true);
  assert.equal(f.engine.calls.filter(call => call.url.endsWith("/start")).length, 0);
  assert.equal(f.engine.containers.size, 0);
  assert.equal((await f.broker.inspect(created.ref)).state, "failed");
});

test("strict RunSpec rejects Docker flags, credentials, traversal and unbounded leases", () => {
  for (const extra of [
    { image: "evil" },
    { env: { TOKEN: "secret" } },
    { privileged: true },
    { tenantId: "../x" },
    { generation: 0 },
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + 31 * 60_000 }
  ]) {
    assert.throws(() => parseRunSpec(spec(extra)), /Invalid|Unexpected/);
  }
});

test("v2 Broker renews only the short lease, replays one target and fences competing or stale requests", async t => {
  let now = Date.now();
  const { broker, engine } = await setup(t, () => now);
  const input = spec({ expiresAt: now + 100000, leaseExpiresAt: now + 10000 });
  const allocation = await started(broker, input);
  const renewal = {
    ref: allocation.ref,
    expectedExpiresAt: input.leaseExpiresAt,
    requestedExpiresAt: now + 30000
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => broker.renew(renewal)));
  assert.ok(results.every(r => r.leaseExpiresAt === renewal.requestedExpiresAt));
  assert.ok(results.every(r => r.digest === allocation.digest && r.expiresAt === input.expiresAt));
  const next = {
    ...renewal,
    expectedExpiresAt: renewal.requestedExpiresAt,
    requestedExpiresAt: now + 40000
  };
  await broker.renew(next);
  await assert.rejects(broker.renew(renewal), { code: "RENEWAL_CONFLICT" });
  await assert.rejects(broker.renew({ ...next, ref: { ...next.ref, tenantId: "foreign" } }), {
    code: "NOT_FOUND"
  });
  now = input.leaseExpiresAt + 1;
  await broker.reconcile();
  assert.equal(engine.containers.size, 1);
  now = next.requestedExpiresAt;
  await assert.rejects(
    broker.renew({
      ...next,
      expectedExpiresAt: next.requestedExpiresAt,
      requestedExpiresAt: now + 10000
    }),
    { code: "STALE_LEASE" }
  );
  await broker.reconcile();
  assert.equal(engine.containers.size, 0);
  assert.equal((await broker.inspect(allocation.ref)).state, "terminated");
  assert.equal(engine.calls.filter(c => c.url.startsWith("/containers/create")).length, 1);
});

test("v2 Broker refuses unstarted, stopped, cancelled and expired-during-inspection renewals", async t => {
  let now = Date.now();
  const { broker, engine } = await setup(t, () => now);
  const unstarted = await broker.allocate(spec({ leaseExpiresAt: now + 10000 }));
  await assert.rejects(
    broker.renew({
      ref: unstarted.ref,
      expectedExpiresAt: now + 10000,
      requestedExpiresAt: now + 20000
    }),
    { code: "STALE_LEASE" }
  );
  await broker.terminate(unstarted.ref);
  const input = spec({
    allocationId: "second",
    runId: "second",
    expiresAt: now + 100000,
    leaseExpiresAt: now + 10000
  });
  const allocation = await started(broker, input);
  const request = {
    ref: allocation.ref,
    expectedExpiresAt: input.leaseExpiresAt,
    requestedExpiresAt: now + 20000
  };
  for (const requestedExpiresAt of [now + 60001, input.expiresAt + 1]) {
    await assert.rejects(broker.renew({ ...request, requestedExpiresAt }), {
      code: "INVALID_SPEC"
    });
  }
  const real = engine.request.bind(engine);
  engine.request = async (...args) => {
    const result = await real(...args);
    if (args[1].endsWith("/json")) now = input.leaseExpiresAt;
    return result;
  };
  await assert.rejects(broker.renew(request), { code: "STALE_LEASE" });
  assert.equal((await broker.inspect(allocation.ref)).leaseExpiresAt, input.leaseExpiresAt);
  await broker.terminate(allocation.ref);
  await assert.rejects(broker.renew(request), { code: "STALE_LEASE" });
});

test("renewal quarantines admission on unknown Docker state until reconciliation succeeds", async t => {
  const now = Date.now();
  const { broker, engine } = await setup(t, () => now);
  const allocation = await started(
    broker,
    spec({ expiresAt: now + 100000, leaseExpiresAt: now + 10000 })
  );
  const request = {
    ref: allocation.ref,
    expectedExpiresAt: now + 10000,
    requestedExpiresAt: now + 30000
  };
  engine.unavailable = true;
  await assert.rejects(broker.renew(request));
  assert.equal(broker.status().ready, false);
  await assert.rejects(broker.allocate(spec({ allocationId: "other", runId: "other" })), {
    code: "NOT_READY"
  });
  engine.unavailable = false;
  await broker.reconcile();
  assert.equal(broker.status().ready, true);
  const container = [...engine.containers.values()][0];
  container.Config.Labels["test.sandlane.broker.digest"] = "foreign";
  await assert.rejects(broker.renew(request), { code: "OWNERSHIP_MISMATCH" });
  assert.equal(broker.status().ready, false);
  assert.equal((await broker.inspect(allocation.ref)).leaseExpiresAt, now + 10000);
});

test("v2 Broker restart retains the renewed receipt but kills the old execution instead of resuming", async t => {
  const now = Date.now();
  const { broker, engine, config } = await setup(t, () => now);
  const original = await started(
    broker,
    spec({ expiresAt: now + 100000, leaseExpiresAt: now + 10000 })
  );
  await broker.renew({
    ref: original.ref,
    expectedExpiresAt: now + 10000,
    requestedExpiresAt: now + 30000
  });
  const restarted = new SandboxBroker(engine, config, () => now);
  await restarted.init();
  const result = await restarted.inspect(original.ref);
  assert.equal(result.leaseExpiresAt, now + 30000);
  assert.equal(result.state, "terminated");
  assert.equal(engine.containers.size, 0);
  await assert.rejects(
    restarted.renew({
      ref: original.ref,
      expectedExpiresAt: now + 30000,
      requestedExpiresAt: now + 40000
    }),
    { code: "STALE_LEASE" }
  );
});
test("parallel replay creates once; tenant/generation binding and hardened config enforced", async t => {
  const { broker, engine } = await setup(t);
  const input = spec();
  const [a, b] = await Promise.all([broker.allocate(input), broker.allocate(input)]);
  assert.deepEqual(a, b);
  assert.equal(engine.calls.filter(c => c.url.startsWith("/containers/create")).length, 1);
  const config = engine.calls.find(c => c.body).body;
  assert.equal(config.HostConfig.NetworkMode, "none");
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.equal(config.User, "1000:1000");
  assert.deepEqual(config.HostConfig.CapDrop, ["ALL"]);
  assert.equal(config.HostConfig.Binds, undefined);
  await assert.rejects(broker.allocate({ ...input, prompt: "changed" }), {
    code: "ALLOCATION_CONFLICT"
  });
  for (const bad of [
    { ...a.ref, tenantId: "tenant-b" },
    { ...a.ref, generation: 2 }
  ]) {
    await assert.rejects(broker.inspect(bad), { code: "NOT_FOUND" });
    await assert.rejects(broker.terminate(bad), { code: "NOT_FOUND" });
  }
  await broker.terminate(a.ref);
  await broker.terminate(a.ref);
  assert.equal(engine.containers.size, 0);
  assert.equal((await broker.allocate(input)).state, "terminated");
});
test("cancel before start leaves a durable tombstone rejecting late allocation", async t => {
  const { broker, engine, config } = await setup(t);
  const input = spec();
  const ref = {
    allocationId: input.allocationId,
    tenantId: input.tenantId,
    runId: input.runId,
    generation: 1
  };
  assert.equal((await broker.terminate(ref)).state, "terminated");
  await assert.rejects(broker.allocate(input), { code: "ALLOCATION_CONFLICT" });
  const restarted = new SandboxBroker(engine, config);
  await restarted.init();
  await assert.rejects(restarted.allocate(input), { code: "ALLOCATION_CONFLICT" });
  await assert.rejects(restarted.terminate({ ...ref, tenantId: "wrong" }), { code: "NOT_FOUND" });
  assert.equal(engine.containers.size, 0);
});

test("queued start and cancellation capture identity before callers can mutate their inputs", async t => {
  const { broker, engine } = await setup(t);
  const input = spec();
  const original = structuredClone(input);
  const starting = broker.allocate(input);
  input.tenantId = "foreign";
  input.prompt = "changed after enqueue";
  const allocation = await starting;
  assert.equal(allocation.ref.tenantId, "tenant-a");
  // The bound digest is the original request's: replaying it is the same allocation.
  assert.deepEqual(await broker.allocate(original), allocation);
  const ref = { ...allocation.ref };
  const inspecting = broker.inspect(ref);
  const stopping = broker.terminate(ref);
  ref.tenantId = "foreign";
  assert.equal((await inspecting).ref.tenantId, "tenant-a");
  assert.equal((await stopping).state, "terminated");
  assert.equal(engine.containers.size, 0);
});

test("lease expiry during Docker start triggers cleanup instead of a successful running receipt", async t => {
  let now = Date.now();
  const { broker, engine } = await setup(t, () => now);
  const original = engine.request.bind(engine);
  t.mock.method(engine, "request", async (method, url, body) => {
    const result = await original(method, url, body);
    if (url.endsWith("/start")) now += 2000;
    return result;
  });
  const input = spec({ leaseExpiresAt: now + 1000 });
  await assert.rejects(started(broker, input), { code: "CHANNEL_UNAVAILABLE" });
  assert.equal(engine.containers.size, 0);
  assert.equal(
    (
      await broker.inspect({
        allocationId: input.allocationId,
        tenantId: input.tenantId,
        runId: input.runId,
        generation: input.generation
      })
    ).state,
    "failed"
  );
});

test("uncertain ledger persistence quarantines admission even after in-process reconciliation", async t => {
  const { broker, engine, root, config } = await setup(t);
  const input = spec();
  await mkdir(path.join(root, `${input.allocationId}.json.pending`));
  await assert.rejects(broker.allocate(input), { code: "EISDIR" });
  assert.equal(engine.containers.size, 0);
  await rm(path.join(root, `${input.allocationId}.json.pending`), { recursive: true });
  await broker.reconcile();
  assert.equal(broker.status().ready, false);
  await assert.rejects(broker.allocate(spec({ allocationId: "next" })), { code: "NOT_READY" });
  const restarted = new SandboxBroker(engine, config);
  await restarted.init();
  assert.equal(restarted.status().ready, true);
});

test("node tenant cap is atomic; duplicate active run is refused", async t => {
  const { broker } = await setup(t);
  const results = await Promise.allSettled(
    [1, 2, 3].map(i => broker.allocate(spec({ allocationId: `alloc-${i}`, runId: `run-${i}` })))
  );
  assert.equal(results.filter(x => x.status === "fulfilled").length, 2);
  assert.equal(results.find(x => x.status === "rejected").reason.code, "CAPACITY");
  await assert.rejects(
    broker.allocate(spec({ allocationId: "other", runId: "run-1", generation: 2 })),
    { code: "RUN_ACTIVE" }
  );
});
test("new allocation IDs cannot replay a terminated Run generation, including after restart", async t => {
  const { broker, engine, config } = await setup(t);
  const a = await broker.allocate(spec());
  await broker.terminate(a.ref);
  const replacement = new SandboxBroker(engine, config);
  await replacement.init();
  await assert.rejects(replacement.allocate(spec({ allocationId: "replay" })), {
    code: "STALE_GENERATION"
  });
  const next = await replacement.allocate(spec({ allocationId: "new-attempt", generation: 2 }));
  assert.equal(next.state, "allocating");
  await replacement.terminate(next.ref);
});
test("lost create response is reconciled and never blindly replays", async t => {
  const { broker, engine } = await setup(t);
  engine.lostCreate = true;
  const input = spec();
  await assert.rejects(broker.allocate(input), /response lost/);
  assert.equal(engine.containers.size, 0);
  assert.equal((await broker.allocate(input)).state, "failed");
});
test("restart terminates prior node allocations instead of resuming stale authority", async t => {
  const { broker, engine, config } = await setup(t);
  const allocation = await broker.allocate(spec());
  const replacement = new SandboxBroker(engine, config);
  await replacement.init();
  assert.equal(engine.containers.size, 0);
  assert.equal((await replacement.inspect(allocation.ref)).state, "terminated");
});
test("expired allocation is reaped and stays terminated after restart", async t => {
  const { engine, config } = await setup(t);
  let now = Date.now();
  const broker = new SandboxBroker(engine, config, () => now);
  await broker.init();
  const a = await started(broker, spec({ expiresAt: now + 1000, leaseExpiresAt: now + 1000 }));
  assert.equal(a.state, "running");
  now += 1001;
  await broker.reconcile();
  assert.equal((await broker.inspect(a.ref)).state, "terminated");
  assert.equal(engine.containers.size, 0);
  const restarted = new SandboxBroker(engine, config);
  await restarted.init();
  assert.equal((await restarted.inspect(a.ref)).state, "terminated");
});

test("output ledger failure still removes expired container and blocks admission", async t => {
  const { engine, config, root } = await setup(t);
  let now = Date.now();
  const broker = new SandboxBroker(engine, config, () => now);
  await broker.init();
  const a = await broker.allocate(spec({ expiresAt: now + 1000, leaseExpiresAt: now + 1000 }));
  // Force the atomic ledger write to fail without changing the container or ledger.
  await mkdir(path.join(root, `${a.ref.allocationId}.json.pending`));
  now += 1001;
  await assert.rejects(broker.reconcile(), { code: "EISDIR" });
  assert.equal(engine.containers.size, 0);
  assert.equal(broker.status().ready, false);
  await assert.rejects(broker.allocate(spec({ allocationId: "next", runId: "next" })), {
    code: "NOT_READY"
  });
});

test("missing ledger with surviving node containers fails closed instead of admitting new runs", async t => {
  const { engine, config } = await setup(t);
  engine.containers.set("orphan", { Id: "a".repeat(64) });
  await assert.rejects(new SandboxBroker(engine, config).init(), { code: "ORPHANED_NODE" });
  assert.equal(engine.containers.size, 1);
});

test("Broker client cancels waiting on the real socket without treating sent mutations as rolled back", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-broker-abort-"));
  const socket = path.join(root, "broker.sock");
  let received;
  const accepted = new Promise(resolve => {
    received = resolve;
  });
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => received());
    // Deliberately leave the reply pending after consuming the mutation.
  });
  await listenUnix(server, socket);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const client = new BrokerClient(socket, "b".repeat(32));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.status(cancelled.signal), { name: "AbortError" });
  const controller = new AbortController();
  const pending = client.renew(
    { ref: {}, expectedExpiresAt: 1, requestedExpiresAt: 2 },
    controller.signal
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await accepted;
  controller.abort();
  await rejected;
});

test("scheduler client completes lifecycle over protected Unix socket and rejects credential replay", async t => {
  const { broker, engine, root } = await setup(t);
  const token = "b".repeat(32);
  const socket = path.join(root, "broker.sock");
  const server = createBrokerServer(broker, token);
  await listenUnix(server, socket);
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const client = new BrokerClient(socket, token);
  await assert.rejects(new BrokerClient(socket, "c".repeat(32)).allocate(spec()), {
    code: "UNAUTHORIZED"
  });
  for (const [version, input, expected] of [
    [2, spec({ schemaVersion: 1 }), 409],
    [1, spec(), 404]
  ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: socket,
          path: `/v${version}/allocate`,
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
        },
        response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }
      );
      request.on("error", reject);
      request.end(JSON.stringify(input));
    });
    assert.equal(status, expected);
  }
  assert.equal(engine.containers.size, 0);
  const a = await client.allocate(spec());
  assert.equal((await client.inspect(a.ref)).state, "allocating");
  assert.equal((await client.terminate(a.ref)).state, "terminated");
  assert.equal(engine.containers.size, 0);
});

test("foreign same-name container is neither read nor removed and quarantines admission", async t => {
  const { broker, engine } = await setup(t);
  const allocation = await broker.allocate(spec());
  const foreign = engine.containers.get(allocation.containerName);
  foreign.Config.Labels = { "test.sandlane.broker": "another-node" };
  foreign.State.Running = false;
  engine.calls.length = 0;
  await assert.rejects(broker.reconcile(), { code: "OWNERSHIP_MISMATCH" });
  assert.equal(broker.status().ready, false);
  assert.equal(
    engine.calls.some(c => c.method === "DELETE"),
    false
  );
  assert.equal(engine.containers.size, 1);
});

test("Broker freezes operator configuration after construction", async t => {
  const { broker, engine, config } = await setup(t);
  config.harnesses.codex.image = "untrusted:latest";
  config.harnesses.codex.launcher = { ...codexLauncher, command: "/bin/sh" };
  config.nodeId = "changed";
  config.maxConcurrent = 10000;
  const allocation = await broker.allocate(spec());
  const container = engine.containers.get(allocation.containerName);
  assert.match(container.Config.Image, /@sha256:/);
  assert.deepEqual(container.Config.Entrypoint, ["/usr/local/bin/codex"]);
  assert.equal(container.Config.Labels["test.sandlane.broker"], "node-test");
  assert.equal(broker.status().capacity, 5);
});

test("each Harness runs its own pinned image and launch description; others are refused", async t => {
  const claude = `test/claude@sha256:${"c".repeat(64)}`;
  const { broker, engine } = await setup(t, Date.now, {
    codex: { image: `test/runner@sha256:${"a".repeat(64)}`, launcher: codexLauncher },
    "claude-code": { image: claude, launcher: claudeCodeLauncher }
  });
  assert.deepEqual(broker.status().harnesses, ["codex", "claude-code"]);
  const allocation = await broker.allocate(spec({ harness: "claude-code" }));
  const container = engine.containers.get(allocation.containerName).Config;
  assert.equal(container.Image, claude);
  assert.deepEqual(container.Entrypoint, ["/usr/local/bin/claude"]);
  assert.deepEqual(container.Cmd, [...claudeCodeLauncher.args]);
  assert.ok(container.Env.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"));
  assert.ok(Object.hasOwn(container.HostConfig.Tmpfs, "/home/runner/.claude"));
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  const created = engine.calls.filter(c => c.url.startsWith("/containers/create")).length;
  await assert.rejects(
    broker.allocate(spec({ allocationId: "alloc-b", runId: "run-b", harness: "opencode" })),
    { code: "HARNESS_UNAVAILABLE" }
  );
  assert.equal(engine.calls.filter(c => c.url.startsWith("/containers/create")).length, created);
  assert.throws(() => parseRunSpec(spec({ harness: "Bad Harness" })), /Invalid harness/);
  await assert.rejects(
    setup(t, Date.now, { codex: { image: "test:latest", launcher: codexLauncher } }),
    /per harness/
  );
});

test("a same-name replacement before attach is never started and quarantines admission", async t => {
  const { broker, engine } = await setup(t);
  const allocation = await broker.allocate(spec());
  const original = engine.containers.get(allocation.containerName);
  engine.containers.set("moved-original", original);
  engine.containers.set(allocation.containerName, {
    ...original,
    Id: "f".repeat(64),
    Config: { Labels: {} },
    State: { Running: false }
  });
  await assert.rejects(broker.openChannel(allocation.ref, new AbortController().signal), {
    code: "OWNERSHIP_MISMATCH"
  });
  assert.equal(engine.calls.filter(c => c.url.endsWith("/start")).length, 0);
  await assert.rejects(broker.reconcile(), { code: "OWNERSHIP_MISMATCH" });
  assert.equal(broker.status().ready, false);
});

test("ownership mismatch cannot delete another workload; daemon outage stops admission", async t => {
  const { broker, engine } = await setup(t);
  const a = await broker.allocate(spec());
  [...engine.containers.values()][0].Config.Labels["test.sandlane.broker"] = "different-node";
  await assert.rejects(broker.terminate(a.ref), { code: "OWNERSHIP_MISMATCH" });
  assert.equal(engine.containers.size, 1);
  engine.unavailable = true;
  await assert.rejects(broker.reconcile(), /unreachable/);
  await assert.rejects(broker.allocate(spec({ allocationId: "next", runId: "next" })), {
    code: "NOT_READY"
  });
});
test("Broker HTTP API requires service identity and never exposes arbitrary Docker operations", async t => {
  const { broker } = await setup(t);
  const token = "x".repeat(32);
  const server = createBrokerServer(broker, token);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauth = await fetch(`${base}/v1/allocate`, {
    method: "POST",
    body: JSON.stringify(spec())
  });
  assert.equal(unauth.status, 401);
  const forbidden = await fetch(`${base}/containers/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(forbidden.status, 404);
  const result = await fetch(`${base}/v2/allocate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(spec())
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).state, "allocating");
});
test("Engine uses the Unix socket with a pinned API version", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-engine-"));
  const socket = path.join(root, "engine.sock");
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.end(JSON.stringify({ Version: "fake" }));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const engine = new DockerEngine(socket);
  assert.deepEqual(await engine.request("GET", "/version"), { Version: "fake" });
  assert.equal(paths[0], "/v1.45/version");
  assert.throws(() => new DockerEngine("relative.sock"));
});

test("container resources follow the configured workspace size and per-harness memory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const config = {
    nodeId: "node-test",
    harnesses: {
      codex: {
        image: `test/runner@sha256:${"a".repeat(64)}`,
        launcher: codexLauncher,
        memoryMiB: 256
      }
    },
    stateDir: root,
    maxConcurrent: 5,
    perTenant: 2,
    labelPrefix: "test.sandlane",
    workspaceMiB: 128
  };
  const broker = new SandboxBroker(engine, config);
  await broker.init();
  const allocation = await broker.allocate(spec());
  const host = engine.containers.get(allocation.containerName).Config.HostConfig;
  assert.equal(host.Memory, 256 * 1024 * 1024);
  assert.equal(host.MemorySwap, 256 * 1024 * 1024);
  assert.equal(host.Tmpfs["/workspace"], "rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700");
  for (const change of [
    { workspaceMiB: 32 },
    { workspaceMiB: 256 },
    { harnesses: { codex: { ...config.harnesses.codex, memoryMiB: 64 } } }
  ])
    assert.throws(() => new SandboxBroker(engine, { ...config, ...change }));
});
