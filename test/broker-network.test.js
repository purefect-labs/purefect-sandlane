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
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { codexLauncher } from "../dist/harness/codex/codex-managed-config.js";
import { SandboxBroker } from "../dist/sandbox/docker/lifecycle.js";
import { BrokerError } from "../dist/sandbox/docker/contracts.js";
import { verifyRelay, parseRelayBinding } from "../dist/sandbox/docker/relay-binding.js";
import { createBrokerServer, listenUnix } from "../dist/sandbox/docker/server.js";
import { BrokerClient } from "../dist/sandbox/docker/client.js";
import { encodeInputs } from "../dist/sandbox/docker/session-inputs.js";
import { decodeOutputs } from "../dist/sandbox/docker/session-outputs.js";

function relayFixture() {
  const routes = JSON.stringify([
    { listenHost: "0.0.0.0", listenPort: 9443, upstreamHost: "192.0.2.1", upstreamPort: 443 }
  ]);
  const binding = {
    containerId: "c".repeat(64),
    imageId: `sha256:${"d".repeat(64)}`,
    policyDigest: createHash("sha256").update(routes).digest("hex")
  };
  const info = {
    Id: binding.containerId,
    Image: binding.imageId,
    State: { Running: true },
    Mounts: [],
    Config: {
      User: "1000:1000",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", `SANDLANE_RELAY_ROUTES=${routes}`],
      Entrypoint: ["/usr/local/bin/node"],
      Cmd: ["/app/bin/relay.js"],
      Labels: {
        "test.sandlane.relay.node": "node",
        "test.sandlane.relay.policy": binding.policyDigest
      }
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges:true"],
      Sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" },
      PortBindings: {},
      NetworkMode: "bridge",
      PidMode: "",
      IpcMode: "private",
      Memory: 128 * 1024 * 1024,
      PidsLimit: 64
    }
  };
  return { binding, info };
}

class Engine {
  networks = new Map();
  containers = new Map();
  fault;
  relay;
  version = "29.8.1";
  execs = [];
  /** Bytes written to each exec's stdin, and the exit state its inspection reports. */
  stdin = [];
  exitCode = 0;
  /** Stdout of an exec by its command (none = empty), and the options each exec started with. */
  reply;
  execOptions = [];
  async startExec(execId, expiresAt, signal, options) {
    const chunks = [];
    this.stdin.push(chunks);
    this.execOptions.push(options);
    const reply = this.reply?.(this.execs.at(-1)?.Cmd ?? []);
    return {
      output: (async function* () {
        // Docker frames output in chunks of at most 128 KiB.
        for (let offset = 0; reply && offset < reply.length; offset += 32 * 1024)
          yield reply.subarray(offset, offset + 32 * 1024);
      })(),
      write: async frame => {
        chunks.push(Buffer.from(frame));
      },
      end: async () => {},
      close() {}
    };
  }
  async request(method, url, body) {
    if (url.startsWith("/exec/")) return { Running: false, ExitCode: this.exitCode };
    if (this.relay && url === `/containers/${this.relay.Id}/json`)
      return structuredClone(this.relay);
    if (url === "/version") return { Version: this.version };
    if (url.startsWith("/networks?")) return [...this.networks.values()];
    if (url.startsWith("/containers/json?")) return [...this.containers.values()];
    if (url === "/networks/create") {
      const info = {
        ...structuredClone(body),
        Id: randomBytes(32).toString("hex"),
        Containers: {}
      };
      this.networks.set(info.Id, info);
      if (["create-lost", "create-and-cleanup"].includes(this.fault))
        throw Error("lost network creation reply");
      if (this.fault === "policy") info.Internal = false;
      return { Id: info.Id };
    }
    if (url.startsWith("/networks/")) {
      const key = url.split("/")[2];
      const info = [...this.networks.values()].find(n => n.Id === key || n.Name === key);
      if (!info) throw new BrokerError("ENGINE_FAILURE", 404, "absent");
      if (url.endsWith("/connect")) {
        info.Containers[body.Container] = { IPv4Address: "172.29.0.1/29" };
        if (this.fault === "connect-lost") throw Error("lost connect reply");
        return null;
      }
      if (url.endsWith("/disconnect")) {
        assert.equal(body.Force, false);
        delete info.Containers[body.Container];
        if (this.fault === "disconnect-lost") throw Error("lost disconnect reply");
        return null;
      }
      if (method === "DELETE") {
        if (["cleanup", "create-and-cleanup"].includes(this.fault))
          throw Error("cannot remove network");
        this.networks.delete(info.Id);
        if (this.fault === "delete-lost") throw Error("lost network deletion reply");
        return null;
      }
      return structuredClone(info);
    }
    if (url.startsWith("/containers/create?")) {
      const Id = randomBytes(32).toString("hex");
      const name = new URL(`http://docker${url}`).searchParams.get("name");
      this.containers.set(Id, {
        Id,
        name,
        Config: structuredClone(body),
        State: { Running: false }
      });
      if (this.fault === "container-create") throw Error("container create reply lost");
      return { Id };
    }
    const key = url.split("/")[2]?.split("?")[0];
    const info = [...this.containers.values()].find(c => c.Id === key || c.name === key);
    if (!info) throw new BrokerError("ENGINE_FAILURE", 404, "absent");
    if (url.endsWith("/exec")) {
      this.execs.push(structuredClone(body));
      return { Id: randomBytes(32).toString("hex") };
    }
    if (url.endsWith("/start")) {
      info.State.Running = true;
      this.networks.get(info.Config.HostConfig.NetworkMode).Containers[info.Id] = {
        IPv4Address: "172.29.0.2/29"
      };
      return null;
    }
    if (url.endsWith("/stop?t=0")) {
      info.State.Running = false;
      delete this.networks.get(info.Config.HostConfig.NetworkMode).Containers[info.Id];
      return null;
    }
    if (method === "DELETE") {
      delete this.networks.get(info.Config.HostConfig.NetworkMode)?.Containers[info.Id];
      this.containers.delete(info.Id);
      return null;
    }
    if (url.endsWith("/json")) return info;
    throw Error("unexpected request");
  }
}

test("session reuses one container with fresh Run credentials, fences old stop and expires after 300 seconds idle", async t => {
  const { engine, config, spec } = await setup(t, true, true);
  let now = Date.now();
  const broker = new SandboxBroker(engine, config, () => now);
  await broker.init();
  spec.session = { taskId: "task", memberId: "member" };
  const first = await broker.allocateManaged({ spec, authorization: authorization(spec) });
  await broker.openChannel(first.ref, new AbortController().signal);
  assert.ok(!JSON.stringify([...engine.containers.values()][0].Config.Env).includes("CAPABILITY"));
  assert.ok(engine.execs[0].Env.includes(`SANDLANE_TOOL_CAPABILITY=${"t".repeat(43)}`));
  const stopped = await broker.terminate(first.ref);
  assert.equal(stopped.stopEvidence, "process-namespace-stopped");
  assert.equal(stopped.idleUntil, now + 300000);
  assert.equal(engine.containers.size, 1);
  const next = { ...spec, allocationId: "b", runId: "next-run" };
  const second = await broker.allocateManaged({
    spec: next,
    authorization: authorization(next, "x".repeat(43), "y".repeat(43))
  });
  assert.equal(second.containerName, first.containerName);
  await broker.openChannel(second.ref, new AbortController().signal);
  assert.ok(engine.execs[1].Env.includes(`SANDLANE_TOOL_CAPABILITY=${"y".repeat(43)}`));
  await broker.terminate(first.ref);
  assert.equal((await broker.inspect(second.ref)).state, "running");
  assert.equal([...engine.containers.values()][0].State.Running, true);
  await broker.terminate(second.ref);
  now += 299999;
  await broker.reconcile();
  assert.equal(engine.containers.size, 1);
  now += 1;
  await broker.reconcile();
  assert.equal(engine.containers.size, 0);
  assert.equal(engine.networks.size, 0);
});

test("session identity includes user and member; idle resources are bounded and restart cleans them", async t => {
  const { engine, config, broker, spec } = await setup(t, true, true);
  spec.session = { taskId: "task", memberId: "member" };
  const first = await broker.allocateManaged({ spec, authorization: authorization(spec) });
  await broker.openChannel(first.ref, new AbortController().signal);
  await assert.rejects(
    broker.allocateManaged({
      spec: { ...spec, allocationId: "b", runId: "b" },
      authorization: authorization(spec)
    }),
    { code: "SESSION_UNAVAILABLE" }
  );
  await broker.terminate(first.ref);
  const foreign = {
    ...spec,
    allocationId: "c",
    runId: "c",
    userId: "other",
    session: { ...spec.session, memberId: "other-member" }
  };
  const other = await broker.allocateManaged({
    spec: foreign,
    authorization: authorization(foreign)
  });
  assert.notEqual(other.containerName, first.containerName);
  assert.equal(engine.containers.size, 1); // perTenant=1 evicts the old idle sandbox
  await broker.openChannel(other.ref, new AbortController().signal);
  await broker.terminate(other.ref);
  await new SandboxBroker(engine, config).init();
  assert.equal(engine.containers.size, 0);
  assert.equal(engine.networks.size, 0);
});

async function setup(t, withRelay = false, managed = false) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "sandlane-network-ledger-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const engine = new Engine();
  const config = {
    nodeId: "node",
    harnesses: { codex: { image: `fixture@sha256:${"a".repeat(64)}`, launcher: codexLauncher } },
    stateDir,
    maxConcurrent: 2,
    perTenant: 1,
    labelPrefix: "test.sandlane",
    networkMode: "isolated",
  };
  if (withRelay) {
    const { binding, info } = relayFixture();
    config.relay = binding;
    engine.relay = info;
  }
  if (managed) {
    config.managedGateways = {
      modelBaseUrl: "https://model.test:9443/v1",
      mcpUrl: "https://mcp.test:9444/mcp"
    };
  }
  const broker = new SandboxBroker(engine, config);
  await broker.init();
  const spec = {
    schemaVersion: 2,
    harness: "codex",
    allocationId: "a",
    tenantId: "tenant",
    userId: "user",
    runId: "run",
    generation: 1,
    prompt: "test",
    expiresAt: Date.now() + 60000,
    leaseExpiresAt: Date.now() + 30000
  };
  return { engine, config, broker, spec };
}

test("Broker persists the exact isolated network before creating the offline CLI", async t => {
  const { engine, config, broker, spec } = await setup(t);
  const record = await broker.allocate(spec);
  const stored = JSON.parse(await readFile(path.join(config.stateDir, "a.json"), "utf8"));
  assert.equal(stored.networkId, record.networkId);
  const container = [...engine.containers.values()][0];
  assert.equal(container.Config.HostConfig.NetworkMode, record.networkId);
  assert.equal(container.Config.NetworkDisabled, false);
  assert.equal(broker.status().network, "isolated");
  assert.equal(broker.status().modelAccess, false);
  await broker.allocate(spec);
  assert.equal(engine.networks.size, 1);
  await broker.terminate(record.ref);
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.containers.size, 0);
  assert.equal(broker.status().active, 0);
});

test("lost create replies and unsupported network policy clean up without retrying execution", async t => {
  for (const fault of ["create-lost", "container-create", "policy"]) {
    const { engine, broker, spec } = await setup(t);
    engine.fault = fault;
    await assert.rejects(broker.allocate(spec));
    assert.equal(engine.networks.size, 0);
    assert.equal(engine.containers.size, 0);
    assert.equal((await broker.allocate(spec)).state, "failed");
  }
});

test("network cleanup failure retains capacity and restart with network mode disabled still cleans it", async t => {
  const { engine, broker, config, spec } = await setup(t);
  const record = await broker.allocate(spec);
  engine.fault = "cleanup";
  await assert.rejects(broker.terminate(record.ref));
  assert.equal(engine.containers.size, 0);
  assert.equal(broker.status().active, 1);
  assert.equal(broker.status().ready, false);
  engine.fault = undefined;
  const restart = new SandboxBroker(engine, { ...config, networkMode: "none" });
  await restart.init();
  assert.equal(engine.networks.size, 0);
  assert.equal(restart.status().active, 0);
  assert.equal((await restart.allocate(spec)).state, "terminated");
});

test("lost network delete response is reconciled without recreating resources", async t => {
  const { engine, broker, spec } = await setup(t);
  const record = await broker.allocate(spec);
  engine.fault = "delete-lost";
  await assert.rejects(broker.terminate(record.ref));
  assert.equal(broker.status().active, 1);
  await broker.reconcile();
  assert.equal(broker.status().active, 0);
  assert.equal(engine.networks.size, 0);
});

test("foreign endpoint or labels quarantine the network without deleting it", async t => {
  for (const foreign of ["endpoint", "label"]) {
    const { engine, broker, spec } = await setup(t);
    const record = await broker.allocate(spec);
    const network = engine.networks.get(record.networkId);
    if (foreign === "endpoint") network.Containers.foreign = {};
    else network.Labels["test.sandlane.broker"] = "other-node";
    await assert.rejects(broker.terminate(record.ref), {
      code: foreign === "endpoint" ? "NETWORK_IN_USE" : "NETWORK_OWNERSHIP_MISMATCH"
    });
    assert.equal(engine.networks.size, 1);
    assert.equal(broker.status().active, 1);
  }
});

test("replacement network with the same name is never adopted or deleted", async t => {
  const { engine, broker, spec } = await setup(t);
  const record = await broker.allocate(spec);
  const original = engine.networks.get(record.networkId);
  engine.networks.delete(record.networkId);
  const replacement = { ...original, Id: "b".repeat(64) };
  engine.networks.set(replacement.Id, replacement);
  await assert.rejects(broker.terminate(record.ref), { code: "NETWORK_REPLACED" });
  assert.equal(engine.networks.has(replacement.Id), true);
});

test("startup refuses orphan networks even if configured for network none", async t => {
  const { engine, config } = await setup(t);
  engine.networks.set("a".repeat(64), { Id: "a".repeat(64) });
  await assert.rejects(new SandboxBroker(engine, { ...config, networkMode: "none" }).init(), {
    code: "ORPHANED_NETWORK"
  });
});

test("old Docker is rejected before creating an isolated network", async t => {
  const { engine, broker, spec } = await setup(t);
  engine.version = "27.5.0";
  await assert.rejects(broker.allocate(spec), { code: "NETWORK_ENGINE_UNSUPPORTED" });
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.containers.size, 0);
});

test("restart recovers the durable network intent when create reply and cleanup both failed", async t => {
  const { engine, broker, config, spec } = await setup(t);
  engine.fault = "create-and-cleanup";
  await assert.rejects(broker.allocate(spec));
  const stored = JSON.parse(await readFile(path.join(config.stateDir, "a.json"), "utf8"));
  assert.equal(stored.networkMode, "isolated");
  assert.equal(stored.networkId, undefined);
  assert.equal(engine.networks.size, 1);
  engine.fault = undefined;
  const restarted = new SandboxBroker(engine, config);
  await restarted.init();
  assert.equal(engine.networks.size, 0);
  assert.equal((await restarted.allocate(spec)).state, "terminated");
});

test("network policy drift prevents attach and cleans the unstarted allocation", async t => {
  const { engine, broker, spec } = await setup(t);
  const record = await broker.allocate(spec);
  engine.networks.get(record.networkId).Internal = false;
  let attached = false;
  engine.attach = async () => {
    attached = true;
    throw Error("must not attach");
  };
  await assert.rejects(broker.openChannel(record.ref, new AbortController().signal), {
    code: "CHANNEL_UNAVAILABLE"
  });
  assert.equal(attached, false);
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.containers.size, 0);
});

test("shared Relay identity is persisted and only its Run network is disconnected", async t => {
  const { engine, broker, config, spec } = await setup(t, true);
  const record = await broker.allocate(spec);
  assert.deepEqual(record.relay, config.relay);
  assert.ok(engine.networks.get(record.networkId).Containers[config.relay.containerId]);
  // Caller mutation cannot redirect a subsequent cleanup or allocation.
  config.relay.containerId = "e".repeat(64);
  await broker.terminate(record.ref);
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.relay.State.Running, true);
});

test("lost Relay connect and disconnect replies retain original recovery semantics", async t => {
  const { engine, broker, spec } = await setup(t, true);
  engine.fault = "connect-lost";
  await assert.rejects(broker.allocate(spec));
  assert.equal(engine.networks.size, 0);
  engine.fault = undefined;
  const record = await broker.allocate({ ...spec, allocationId: "b", generation: 2 });
  engine.fault = "disconnect-lost";
  await assert.rejects(broker.terminate(record.ref));
  assert.equal(broker.status().active, 1);
  await broker.reconcile();
  assert.equal(broker.status().active, 0);
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.relay.State.Running, true);
});

test("restart cleans the original Relay attachment after operator configuration changes", async t => {
  const { engine, broker, config, spec } = await setup(t, true);
  const record = await broker.allocate(spec);
  const { relay: _old, ...withoutRelay } = config;
  const restart = new SandboxBroker(engine, withoutRelay);
  await restart.init();
  assert.equal((await restart.inspect(record.ref)).state, "terminated");
  assert.equal(engine.networks.size, 0);
  assert.equal(engine.relay.State.Running, true);
});

test("Relay verifier rejects unsafe containers despite matching identity labels", async () => {
  const changes = [
    r => {
      r.Image = `sha256:${"f".repeat(64)}`;
    },
    r => {
      r.State.Running = false;
    },
    r => {
      r.HostConfig.Privileged = true;
    },
    r => {
      r.HostConfig.Sysctls["net.ipv4.ip_forward"] = "1";
    },
    r => {
      r.Config.Env.push("NODE_OPTIONS=--inspect=0.0.0.0");
    },
    r => {
      r.Mounts.push({ Destination: "/var/run/docker.sock" });
    },
    r => {
      r.Config.Cmd = ["-e", "arbitrary()"];
    },
    r => {
      r.HostConfig.NetworkMode = "host";
    },
    r => {
      r.HostConfig.PortBindings["9443/tcp"] = [{ HostPort: "9443" }];
    },
    r => {
      r.Config.Env[1] += " ";
    }
  ];
  for (const change of changes) {
    const { binding, info } = relayFixture();
    const engine = new Engine();
    engine.relay = info;
    change(info);
    await assert.rejects(verifyRelay(engine, "node", "test.sandlane", binding), { code: "RELAY_POLICY_MISMATCH" });
  }
  assert.throws(() => parseRelayBinding({ containerId: "mutable-name" }));
});

test("reconciliation stops the Run if its pinned Relay exits", async t => {
  const { engine, broker, spec } = await setup(t, true);
  const record = await broker.allocate(spec);
  engine.relay.State.Running = false;
  await broker.reconcile();
  assert.equal(engine.containers.size, 0);
  assert.equal(engine.networks.size, 0);
  assert.equal((await broker.inspect(record.ref)).state, "failed");
  assert.equal(broker.status().active, 0);
});

function authorization(spec, model = "m".repeat(43), tool = "t".repeat(43)) {
  return {
    modelAlias: "approved",
    toolServer: "tools",
    enabledTools: ["metadata_read"],
    model: { value: model, expiresAt: spec.expiresAt },
    tool: { value: tool, expiresAt: spec.expiresAt }
  };
}

test("managed launch injects only scoped credentials and hashes their immutable binding", async t => {
  const { engine, broker, config, spec } = await setup(t, true, true);
  const auth = authorization(spec);
  const result = await broker.allocateManaged({ spec, authorization: auth });
  const container = [...engine.containers.values()][0];
  assert.ok(container.Config.Env.includes(`SANDLANE_MODEL_CAPABILITY=${auth.model.value}`));
  assert.ok(container.Config.Env.includes(`SANDLANE_TOOL_CAPABILITY=${auth.tool.value}`));
  assert.deepEqual(container.Config.HostConfig.ExtraHosts, [
    "model.test:172.29.0.1",
    "mcp.test:172.29.0.1"
  ]);
  assert.ok(container.Config.Cmd.includes('model="approved"'));
  assert.equal(container.Config.Cmd.at(-1), "app-server");
  for (const output of [
    JSON.stringify(result),
    await readFile(path.join(config.stateDir, "a.json"), "utf8"),
    JSON.stringify(broker.status())
  ]) {
    assert.ok(!output.includes(auth.model.value));
    assert.ok(!output.includes(auth.tool.value));
  }
  assert.equal(
    (await broker.allocateManaged({ spec, authorization: auth })).launchDigest,
    result.launchDigest
  );
  await assert.rejects(
    broker.allocateManaged({ spec, authorization: authorization(spec, "x".repeat(43)) }),
    { code: "ALLOCATION_CONFLICT" }
  );
  await assert.rejects(broker.allocate(spec), { code: "MANAGED_LAUNCH_REQUIRED" });
  await broker.shutdown();
});

test("managed launch rejects URL/env injection and expired or shared capabilities before resource creation", async t => {
  const { engine, broker, spec } = await setup(t, true, true);
  const base = authorization(spec);
  for (const change of [
    { mcpUrl: "https://evil.test" },
    { env: { OPENAI_API_KEY: "key" } },
    { model: { ...base.model, expiresAt: Date.now() - 1 } },
    { tool: base.model },
    { enabledTools: ["tool", "tool"] }
  ]) {
    await assert.rejects(broker.allocateManaged({ spec, authorization: { ...base, ...change } }));
    assert.equal(engine.networks.size, 0);
    assert.equal(engine.containers.size, 0);
  }
});

test("restart retains only the launch digest and cleans the original container without credentials", async t => {
  const { engine, broker, config, spec } = await setup(t, true, true);
  await broker.allocateManaged({ spec, authorization: authorization(spec) });
  const restarted = new SandboxBroker(engine, config);
  await restarted.init();
  assert.equal(engine.containers.size, 0);
  assert.equal(engine.networks.size, 0);
  assert.equal(
    (await restarted.allocateManaged({ spec, authorization: authorization(spec) })).state,
    "terminated"
  );
});

test("managed allocation uses an authenticated Unix endpoint and rejects browser or ambiguous auth", async t => {
  const { broker, config, spec } = await setup(t, true, true);
  const nodeToken = randomBytes(32).toString("base64url");
  const server = createBrokerServer(broker, nodeToken);
  const socketPath = path.join(config.stateDir, "broker.sock");
  await listenUnix(server, socketPath);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const auth = authorization(spec);
  const client = new BrokerClient(socketPath, nodeToken);
  assert.equal((await client.allocateManaged(spec, auth)).state, "allocating");
  await assert.rejects(
    client.allocateManaged(spec, {
      ...auth,
      model: { value: nodeToken, expiresAt: spec.expiresAt }
    }),
    { code: "CREDENTIAL_ROLE_CONFLICT" }
  );
  await assert.rejects(new BrokerClient(socketPath, "x".repeat(43)).allocateManaged(spec, auth), {
    status: 401
  });
  for (const [headers, expected] of [
    [["Authorization", `Bearer ${nodeToken}`, "Origin", "https://browser.test"], 403],
    [["Authorization", `Bearer ${nodeToken}`, "Authorization", `Bearer ${nodeToken}`], 401]
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: "/v3/allocate",
          method: "POST",
          headers: [
            ...headers,
            "Host",
            "localhost",
            "Content-Length",
            "2",
            "Content-Type",
            "application/json"
          ]
        },
        res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, expected);
  }
  await broker.shutdown();
});

test("put inputs: written into the session before its CLI, as the runner, idempotent per allocation", async t => {
  const { engine, broker, spec } = await setup(t, true, true);
  spec.session = { taskId: "task", memberId: "member" };
  const first = await broker.allocateManaged({ spec, authorization: authorization(spec) });
  const files = [
    { name: "report.pdf", data: Buffer.from("%PDF") },
    { name: "manifest.json", data: Buffer.from("[]") }
  ];
  const body = encodeInputs(first.ref, files);
  const receipt = await broker.putInputs(body);
  assert.deepEqual(receipt, { ref: first.ref, files: 2, bytes: 6 });
  const container = [...engine.containers.values()][0];
  assert.equal(container.State.Running, true);
  // Default resources: 96 MiB workspace tmpfs within the 512 MiB container limit.
  assert.equal(container.Config.HostConfig.Memory, 512 * 1024 * 1024);
  assert.match(container.Config.HostConfig.Tmpfs["/workspace"], /,size=96m,/);
  // A credential-free exec of tar as the runner user, fed the Broker-built archive.
  assert.deepEqual(engine.execs[0], {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Cmd: ["tar", "-x", "-f", "-", "-C", "/workspace"],
    Env: []
  });
  const archive = Buffer.concat(engine.stdin[0]);
  assert.equal(archive.subarray(0, 7).toString(), "inputs/");
  assert.ok(archive.includes(Buffer.from("inputs/report.pdf")));
  assert.ok(archive.includes(Buffer.from("%PDF")));
  // The same request again is acknowledged without writing; other inputs are refused.
  assert.deepEqual(await broker.putInputs(body), receipt);
  assert.equal(engine.stdin.length, 1);
  await assert.rejects(
    broker.putInputs(encodeInputs(first.ref, [{ name: "other.txt", data: Buffer.from("x") }])),
    { code: "INPUTS_CONFLICT" }
  );
  // The CLI then starts in the already running session container.
  await broker.openChannel(first.ref, new AbortController().signal);
  assert.equal((await broker.inspect(first.ref)).state, "running");
  assert.ok(engine.execs[1].Env.includes(`SANDLANE_TOOL_CAPABILITY=${"t".repeat(43)}`));
  // A foreign binding is not found.
  await assert.rejects(broker.putInputs(encodeInputs({ ...first.ref, tenantId: "other" }, files)), {
    code: "NOT_FOUND"
  });
});

test("put inputs: refused once the CLI runs, for non-session allocations, and on a failed extraction", async t => {
  const { engine, broker, spec } = await setup(t, true, true);
  spec.session = { taskId: "task", memberId: "member" };
  const files = [{ name: "a.txt", data: Buffer.from("a") }];
  const first = await broker.allocateManaged({ spec, authorization: authorization(spec) });
  await broker.openChannel(first.ref, new AbortController().signal);
  await assert.rejects(broker.putInputs(encodeInputs(first.ref, files)), {
    code: "INPUTS_DENIED"
  });
  await broker.terminate(first.ref);
  const plain = { ...spec, allocationId: "b", runId: "b" };
  delete plain.session;
  const other = await broker.allocateManaged({ spec: plain, authorization: authorization(plain) });
  await assert.rejects(broker.putInputs(encodeInputs(other.ref, files)), {
    code: "INPUTS_DENIED"
  });
  await broker.terminate(other.ref);
  engine.exitCode = 2;
  const next = { ...spec, allocationId: "c", runId: "c" };
  const third = await broker.allocateManaged({ spec: next, authorization: authorization(next) });
  await assert.rejects(broker.putInputs(encodeInputs(third.ref, files)), {
    code: "INPUTS_FAILED"
  });
  // Nothing is recorded for a failed write: the caller terminates the allocation.
  await broker.terminate(third.ref);
  assert.equal((await broker.inspect(third.ref)).state, "terminated");
});

test("file tools: only for a session, and its CLI starts only over written inputs", async t => {
  const { engine, broker, spec } = await setup(t, true, true);
  const withFiles = s => ({ ...authorization(s), fileTools: true });
  await assert.rejects(broker.allocateManaged({ spec, authorization: withFiles(spec) }), {
    code: "FILE_TOOLS_DENIED"
  });
  spec.session = { taskId: "task", memberId: "member" };
  const missing = { ...spec, allocationId: "b", runId: "b" };
  const unwritten = await broker.allocateManaged({
    spec: missing,
    authorization: withFiles(missing)
  });
  await assert.rejects(broker.openChannel(unwritten.ref, new AbortController().signal), {
    code: "CHANNEL_UNAVAILABLE"
  });
  assert.equal(engine.execs.length, 0);
  const next = { ...spec, allocationId: "c", runId: "c" };
  const ready = await broker.allocateManaged({ spec: next, authorization: withFiles(next) });
  await broker.putInputs(
    encodeInputs(ready.ref, [{ name: "manifest.json", data: Buffer.from("[]") }])
  );
  await broker.openChannel(ready.ref, new AbortController().signal);
  const cli = engine.execs.at(-1);
  assert.ok(cli.Cmd.includes("features.shell_tool=true"));
  assert.ok(cli.Cmd.includes("features.view_image=true"));
});

/** A POSIX ustar archive of regular files {name, data} (names ASCII, at most 100 bytes). */
function ustar(files) {
  const parts = [];
  for (const { name, data } of files) {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, "ascii");
    block.write("0000644\u0000", 100, "ascii");
    block.write(`${data.length.toString(8).padStart(11, "0")}\u0000`, 124, "ascii");
    block.write("        ", 148, "ascii");
    block.write("0", 156, "ascii");
    block.write("ustar\u000000", 257, "latin1");
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
    parts.push(block, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

async function fileSession(t, allocationId = "a") {
  const { engine, broker, spec } = await setup(t, true, true);
  spec.session = { taskId: "task", memberId: "member" };
  const next = { ...spec, allocationId, runId: allocationId };
  const record = await broker.allocateManaged({
    spec: next,
    authorization: { ...authorization(next), fileTools: true }
  });
  await broker.putInputs(
    encodeInputs(record.ref, [{ name: "manifest.json", data: Buffer.from("[]") }])
  );
  return { engine, broker, spec, ref: record.ref };
}

test("get outputs: listed as the runner, regular files read by exact name, the rest refused", async t => {
  const { engine, broker, ref } = await fileSession(t);
  // Before the CLI has run there is nothing to read.
  await assert.rejects(broker.getOutputs(ref), { code: "OUTPUTS_DENIED" });
  await broker.openChannel(ref, new AbortController().signal);
  const listing = [
    "1 d 4096 outputs",
    "2 f 3 outputs/report.pdf",
    "2 l 11 outputs/link.pdf",
    "2 d 4096 outputs/sub",
    "2 f 5 outputs/.hidden"
  ]
    .map(record => `${record}\0`)
    .join("");
  engine.reply = command =>
    command[0] === "find"
      ? Buffer.from(listing)
      : ustar([{ name: "report.pdf", data: Buffer.from("%PD") }]);
  const outputs = decodeOutputs(Buffer.concat(await broker.getOutputs(ref)));
  assert.deepEqual(
    outputs.files.map(file => [file.name, file.data.toString()]),
    [["report.pdf", "%PD"]]
  );
  assert.deepEqual(
    outputs.rejected.map(item => [item.name, item.reason]),
    [
      [".hidden", "invalid_name"],
      ["link.pdf", "not_regular_file"],
      ["sub", "not_regular_file"]
    ]
  );
  const [find, tar] = engine.execs.slice(-2);
  for (const exec of [find, tar]) {
    assert.equal(exec.User, "1000:1000");
    assert.equal(exec.AttachStdin, false);
    assert.deepEqual(exec.Env, []);
  }
  assert.equal(find.Cmd[0], "find");
  assert.deepEqual(tar.Cmd.slice(-2), ["--", "report.pdf"]);
  // The archive read is capped near the listed sizes, far below the default 4 MiB.
  assert.ok(engine.execOptions.at(-1).maxOutputBytes < 64 * 1024 + 128 * 1024);
  // No outputs directory: an empty reply, and no archive read.
  const execs = engine.execs.length;
  engine.reply = () => Buffer.alloc(0);
  assert.deepEqual(decodeOutputs(Buffer.concat(await broker.getOutputs(ref))), {
    files: [],
    rejected: []
  });
  assert.equal(engine.execs.length, execs + 1);
  // A file changed while read (tar exits 1) fails the whole read.
  engine.reply = command =>
    command[0] === "find" ? Buffer.from(listing) : ustar([{ name: "report.pdf", data: Buffer.from("%PD") }]);
  engine.exitCode = 1;
  await assert.rejects(broker.getOutputs(ref), { code: "OUTPUTS_FAILED" });
  engine.exitCode = 0;
  // An archive larger than the listing promised is cut off and refused.
  engine.reply = command =>
    command[0] === "find"
      ? Buffer.from(listing)
      : ustar([{ name: "report.pdf", data: Buffer.alloc(512 * 1024) }]);
  await assert.rejects(broker.getOutputs(ref), { code: "OUTPUTS_FAILED" });
  // Once terminated, the session's files are gone with it.
  await broker.terminate(ref);
  await assert.rejects(broker.getOutputs(ref), { code: "OUTPUTS_DENIED" });
});

test("get outputs: refused for sessions without inputs and foreign bindings", async t => {
  const { engine, broker, spec } = await setup(t, true, true);
  spec.session = { taskId: "task", memberId: "member" };
  const plain = await broker.allocateManaged({ spec, authorization: authorization(spec) });
  await broker.openChannel(plain.ref, new AbortController().signal);
  await assert.rejects(broker.getOutputs(plain.ref), { code: "OUTPUTS_DENIED" });
  await assert.rejects(broker.getOutputs({ ...plain.ref, tenantId: "other" }), {
    code: "NOT_FOUND"
  });
  assert.equal(engine.execs.filter(exec => exec.Cmd[0] === "find").length, 0);
});

test("get outputs over the Broker socket: JSON request, binary reply, JSON errors", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-outputs-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "broker.sock");
  const token = "t".repeat(40);
  const ref = { allocationId: "a", tenantId: "7", runId: "1", generation: 1 };
  const calls = [];
  const header = Buffer.from(JSON.stringify({ files: [{ name: "月报.csv", size: 3 }], rejected: [] }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const server = createBrokerServer(
    {
      getOutputs: async value => {
        calls.push(value);
        if (value.runId === "denied") throw new BrokerError("OUTPUTS_DENIED", 409, "no");
        return [length, header, Buffer.from("a,b")];
      }
    },
    token
  );
  await listenUnix(server, socket);
  t.after(() => server.close());
  const client = new BrokerClient(socket, token);
  const outputs = await client.getOutputs(ref);
  assert.equal(outputs.files[0].name, "月报.csv");
  assert.equal(outputs.files[0].data.toString(), "a,b");
  assert.deepEqual(calls, [ref]);
  await assert.rejects(client.getOutputs({ ...ref, runId: "denied" }), {
    code: "OUTPUTS_DENIED"
  });
  await assert.rejects(new BrokerClient(socket, "u".repeat(40)).getOutputs(ref), {
    code: "UNAUTHORIZED"
  });
});
