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
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexLauncher } from "../dist/harness/codex/codex-managed-config.js";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { SandboxBroker } from "../dist/sandbox/docker/lifecycle.js";

const image = process.env.DOCKER_TEST_IMAGE,
  relayImage = process.env.DOCKER_RELAY_IMAGE;
for (const ref of [image, relayImage])
  assert.match(ref ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const socket = process.env.DOCKER_TEST_SOCKET ?? "";
const docker = new DockerEngine(socket),
  exec = promisify(execFile);
const nodeId = `relay-${randomUUID()}`,
  labelPrefix = "validation.sandlane",
  tag = `${labelPrefix}.relay-check`;
const root = await mkdtemp(
  path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "sandlane-relay-broker-")
);
const infrastructure = [],
  networks = [],
  channels = [],
  checks = [];
let broker,
  fault,
  passed = false;
const managed = process.argv.includes("--managed");
const authorizations = new Map();
function allocate(input) {
  if (!managed) return broker.allocate(input);
  const authorization = {
    modelAlias: "fixture",
    toolServer: "tools",
    enabledTools: ["metadata_read"],
    model: { value: randomBytes(32).toString("base64url"), expiresAt: input.expiresAt },
    tool: { value: randomBytes(32).toString("base64url"), expiresAt: input.expiresAt }
  };
  authorizations.set(input.allocationId, authorization);
  return broker.allocateManaged({ spec: input, authorization });
}
const engine = {
  attach: (...args) => docker.attach(...args),
  async request(method, url, body) {
    const result = await docker.request(method, url, body);
    if (fault && url.endsWith(`/${fault}`)) throw Error(`injected lost ${fault} reply`);
    return result;
  }
};
async function create(name, image, net, cmd, labels = {}, env = []) {
  const result = await docker.request("POST", `/containers/create?name=${nodeId}-${name}`, {
    Image: image,
    User: "1000:1000",
    Entrypoint: ["/usr/local/bin/node"],
    Cmd: cmd,
    Env: env,
    Labels: { [tag]: nodeId, ...labels },
    HostConfig: {
      NetworkMode: net,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NanoCpus: 500000000,
      Sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" },
      LogConfig: { Type: "none" }
    }
  });
  infrastructure.push(result.Id);
  await docker.request("POST", `/containers/${result.Id}/start`);
  return result.Id;
}
async function probe(containerId, host, port, expected) {
  const code = `import net from 'node:net'; const s=net.connect(${port},${JSON.stringify(host)});
    let done=false; const end=v=>{if(done)return;done=true;clearTimeout(timer);s.destroy();console.log(v)};
    const timer=setTimeout(()=>end('blocked'),800);s.on('error',()=>end('blocked'));s.on('data',b=>end(b.toString().trim()));`;
  const { stdout } = await exec(
    "docker",
    [
      "--host",
      `unix://${socket}`,
      "exec",
      containerId,
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      code
    ],
    { timeout: 5000, maxBuffer: 8192 }
  );
  assert.equal(stdout.trim(), expected);
}
function spec(id) {
  return {
    schemaVersion: 2,
    harness: "codex",
    allocationId: id,
    runId: id,
    tenantId: id,
    userId: id,
    generation: 1,
    prompt: "No model request",
    expiresAt: Date.now() + 60000,
    leaseExpiresAt: Date.now() + 30000
  };
}
try {
  const relayMetadata = await docker.request(
    "GET",
    `/images/${encodeURIComponent(relayImage)}/json`
  );
  assert.ok(relayMetadata.RepoDigests.includes(relayImage));
  const network = await docker.request("POST", "/networks/create", {
    Name: `${nodeId}-upstream`,
    Driver: "bridge",
    Internal: true,
    Labels: { [tag]: nodeId },
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }
  });
  networks.push(network.Id);
  const upstream = await create("upstream", image, network.Id, [
    "--input-type=module",
    "-e",
    "import net from 'node:net'; net.createServer(s=>{s.on('error',()=>{});s.end('fixed-upstream\\n')}).listen(9443,'0.0.0.0')"
  ]);
  const upstreamInfo = await docker.request("GET", `/containers/${upstream}/json`);
  const upstreamIp = Object.values(upstreamInfo.NetworkSettings.Networks)[0].IPAddress;
  const routes = JSON.stringify([
    { listenHost: "0.0.0.0", listenPort: 9443, upstreamHost: upstreamIp, upstreamPort: 9443 }
  ]);
  const policyDigest = createHash("sha256").update(routes).digest("hex");
  const relay = await create(
    "relay",
    relayImage,
    network.Id,
    ["/app/bin/relay.js"],
    {
      [`${labelPrefix}.relay.node`]: nodeId,
      [`${labelPrefix}.relay.policy`]: policyDigest
    },
    [`SANDLANE_RELAY_ROUTES=${routes}`]
  );
  const config = {
    nodeId,
    harnesses: { codex: { image, launcher: codexLauncher } },
    stateDir: root,
    maxConcurrent: 2,
    perTenant: 1,
    labelPrefix,
    networkMode: "isolated",
    relay: { containerId: relay, imageId: relayMetadata.Id, policyDigest }
  };
  if (managed) {
    config.managedGateways = {
      modelBaseUrl: "https://gateway.test:9443/v1",
      mcpUrl: "https://gateway.test:9443/mcp"
    };
  }
  broker = new SandboxBroker(engine, config);
  await broker.init();
  const records = [];
  for (const id of ["run-a", "run-b"]) {
    const record = await allocate(spec(id));
    records.push(record);
    const channel = await broker.openChannel(record.ref, new AbortController().signal);
    channels.push(channel);
    const container = await docker.request("GET", `/containers/${record.containerName}/json`);
    const net = await docker.request("GET", `/networks/${record.networkId}`);
    const relayIp = net.Containers[relay].IPv4Address.split("/")[0];
    await probe(container.Id, managed ? "gateway.test" : relayIp, 9443, "fixed-upstream");
    if (managed) {
      const auth = authorizations.get(id);
      assert.ok(container.Config.Env.includes(`SANDLANE_MODEL_CAPABILITY=${auth.model.value}`));
      assert.ok(container.Config.Env.includes(`SANDLANE_TOOL_CAPABILITY=${auth.tool.value}`));
      const ledger = await readFile(path.join(root, `${id}.json`), "utf8");
      for (const expected of authorizations.values()) {
        assert.ok(!ledger.includes(expected.model.value));
        assert.ok(!ledger.includes(expected.tool.value));
        if (expected !== auth) {
          assert.ok(!JSON.stringify(container.Config).includes(expected.model.value));
          assert.ok(!JSON.stringify(container.Config).includes(expected.tool.value));
        }
      }
      checks.push(
        `${id}: scoped fixture capabilities in its environment only; ledger has no raw tokens`
      );
    }
    await probe(container.Id, upstreamIp, 9443, "blocked");
    checks.push(`${id}: pinned Relay reachable; direct upstream blocked`);
  }
  await broker.terminate(records[0].ref);
  const liveRelay = await docker.request("GET", `/containers/${relay}/json`);
  assert.equal(liveRelay.State.Running, true);
  assert.ok(
    Object.values(liveRelay.NetworkSettings.Networks).some(
      n => n.NetworkID === records[1].networkId
    )
  );
  await broker.terminate(records[1].ref);
  checks.push("terminating one Run preserves the shared Relay and the other Run attachment");

  fault = "connect";
  await assert.rejects(allocate(spec("lost-connect")));
  fault = undefined;
  const lost = await allocate(spec("lost-disconnect"));
  fault = "disconnect";
  await assert.rejects(broker.terminate(lost.ref));
  assert.equal(broker.status().active, 1);
  fault = undefined;
  const { relay: _old, managedGateways: _gateways, ...withoutRelay } = config;
  broker = new SandboxBroker(engine, withoutRelay);
  await broker.init();
  assert.equal(broker.status().active, 0);
  assert.equal((await docker.request("GET", `/containers/${relay}/json`)).State.Running, true);
  checks.push(
    "lost connect/disconnect replies recover original journal without deleting shared Relay"
  );
  broker = new SandboxBroker(engine, config);
  await broker.init();
  const interrupted = await allocate(spec("relay-exit"));
  channels.push(await broker.openChannel(interrupted.ref, new AbortController().signal));
  await docker.request("POST", `/containers/${relay}/stop?t=1`);
  await broker.reconcile();
  assert.equal((await broker.inspect(interrupted.ref)).state, "failed");
  assert.equal(broker.status().active, 0);
  checks.push("Relay process exit causes the active Run to stop and its network to be reclaimed");
  passed = true;
} finally {
  fault = undefined;
  for (const channel of channels) channel.close();
  await broker?.shutdown();
  for (const id of infrastructure.reverse()) {
    const info = await docker.request("GET", `/containers/${id}/json`);
    assert.equal(info.Config.Labels[tag], nodeId);
    await docker.request("DELETE", `/containers/${id}?force=true&v=true`);
  }
  for (const id of networks) {
    const info = await docker.request("GET", `/networks/${id}`);
    assert.equal(info.Labels[tag], nodeId);
    await docker.request("DELETE", `/networks/${id}`);
  }
  let remainingContainers = 0,
    remainingNetworks = 0;
  for (const label of [`${tag}=${nodeId}`, `${labelPrefix}.broker=${nodeId}`]) {
    const filter = encodeURIComponent(JSON.stringify({ label: [label] }));
    remainingContainers += (
      await docker.request("GET", `/containers/json?all=true&filters=${filter}`)
    ).length;
    remainingNetworks += (await docker.request("GET", `/networks?filters=${filter}`)).length;
  }
  const report = {
    passed: passed && !remainingContainers && !remainingNetworks,
    image,
    relayImage,
    managedLaunchWithFixtureCapabilities: managed,
    checks,
    remainingContainers,
    remainingNetworks,
    modelCalls: false,
    businessMcp: false
  };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: path.join(root, "report.json") }, null, 2));
  assert.equal(remainingContainers, 0);
  assert.equal(remainingNetworks, 0);
}
