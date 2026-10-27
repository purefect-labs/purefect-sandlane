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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";

// Disposable topology experiment, not the Broker's production network allocator.
const image = process.env.DOCKER_TEST_IMAGE;
const socket = process.env.DOCKER_TEST_SOCKET;
assert.match(image ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
assert.ok(socket?.startsWith("/"));
const engine = new DockerEngine(socket);
const exec = promisify(execFile);
const tag = `sandlane-egress-${randomUUID()}`;
const label = "validation.sandlane.network";
const containers = [];
const networks = [];
const checks = [];
const root = await mkdtemp(
  path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "sandlane-egress-")
);
const report = {
  schemaVersion: 1,
  passed: false,
  checks,
  remainingContainers: null,
  remainingNetworks: null
};

async function network(suffix) {
  const value = await engine.request("POST", "/networks/create", {
    Name: `${tag}-${suffix}`,
    Driver: "bridge",
    Internal: true,
    EnableIPv6: false,
    Labels: { [label]: tag },
    Options: {
      "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
      "com.docker.network.bridge.enable_icc": "true"
    }
  });
  assert.match(value.Id, /^[a-f0-9]{64}$/);
  networks.push(value.Id);
  const info = await engine.request("GET", `/networks/${value.Id}`);
  assert.equal(info.Internal, true);
  assert.equal(info.Options["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
  return value.Id;
}

async function container(suffix, networkId, code) {
  const value = await engine.request("POST", `/containers/create?name=${tag}-${suffix}`, {
    Image: image,
    User: "1000:1000",
    Entrypoint: ["/usr/local/bin/node"],
    Cmd: ["--input-type=module", "-e", code],
    Labels: { [label]: tag },
    HostConfig: {
      NetworkMode: networkId,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NanoCpus: 500000000,
      LogConfig: { Type: "none", Config: {} },
      Sysctls: { "net.ipv4.ip_forward": "0" }
    }
  });
  assert.match(value.Id, /^[a-f0-9]{64}$/);
  containers.push(value.Id);
  return value.Id;
}

async function address(id, networkId) {
  const info = await engine.request("GET", `/containers/${id}/json`);
  return Object.values(info.NetworkSettings.Networks).find(n => n.NetworkID === networkId)
    .IPAddress;
}

async function probe(id, host, port, expected) {
  const code = `import net from 'node:net';
    const s = net.connect(${port}, ${JSON.stringify(host)});
    let result = ''; const timer = setTimeout(() => finish('blocked'), 800);
    const finish = value => { clearTimeout(timer); s.destroy(); console.log(value); };
    s.on('error', () => finish('blocked'));
    s.on('data', data => { result += data; if(result.includes('\\n')) finish(result.trim()); });`;
  const { stdout } = await exec(
    "docker",
    [
      "--host",
      `unix://${socket}`,
      "exec",
      id,
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      code
    ],
    { timeout: 5000, maxBuffer: 8192 }
  );
  assert.equal(stdout.trim(), expected, `${host}:${port}`);
  checks.push({ host, port, result: expected });
}

const listener = (port, text) => `import net from 'node:net';
  net.createServer(s => { s.on('error',()=>{}); s.end(${JSON.stringify(text + "\n")}); }).listen(${port}, '0.0.0.0');`;

try {
  const version = await engine.request("GET", "/version");
  report.engineVersion = version.Version;
  const metadata = await engine.request("GET", `/images/${encodeURIComponent(image)}/json`);
  assert.ok(metadata.RepoDigests?.includes(image));
  // Sequential creation ensures a failure cannot race cleanup with another create.
  const upstreamNet = await network("upstream");
  const firstNet = await network("a");
  const secondNet = await network("b");
  const upstream = await container("upstream", upstreamNet, listener(9443, "gateway-only"));
  await engine.request("POST", `/containers/${upstream}/start`);
  const upstreamIp = await address(upstream, upstreamNet);
  const relayCode = await readFile(
    new URL("../dist/network/gateway-relay.js", import.meta.url),
    "utf8"
  );
  const relay = await container(
    "relay",
    upstreamNet,
    `${relayCode}
    const relay = new GatewayRelay([{listenHost:'0.0.0.0',listenPort:9443,
      upstreamHost:${JSON.stringify(upstreamIp)},upstreamPort:9443}]);
    await relay.start();`
  );
  await engine.request("POST", `/networks/${firstNet}/connect`, { Container: relay });
  await engine.request("POST", `/networks/${secondNet}/connect`, { Container: relay });
  await engine.request("POST", `/containers/${relay}/start`);
  const first = await container("a", firstNet, listener(9000, "run-a"));
  const second = await container("b", secondNet, listener(9000, "run-b"));
  await engine.request("POST", `/containers/${first}/start`);
  await engine.request("POST", `/containers/${second}/start`);
  const firstIp = await address(first, firstNet);
  const secondIp = await address(second, secondNet);
  const firstRelay = await address(relay, firstNet);
  const secondRelay = await address(relay, secondNet);
  await probe(first, "127.0.0.1", 9000, "run-a");
  await probe(second, "127.0.0.1", 9000, "run-b");
  await probe(first, firstRelay, 9443, "gateway-only");
  await probe(second, secondRelay, 9443, "gateway-only");
  await probe(first, secondIp, 9000, "blocked");
  await probe(second, firstIp, 9000, "blocked");
  await probe(first, upstreamIp, 9443, "blocked");
  await probe(first, firstRelay, 2375, "blocked");
  await probe(first, "1.1.1.1", 443, "blocked");
  await probe(first, "169.254.169.254", 80, "blocked");
  await probe(first, "host.docker.internal", 8788, "blocked");
  await probe(first, "2606:4700:4700::1111", 443, "blocked");
  const { stdout } = await exec(
    "docker",
    [
      "--host",
      `unix://${socket}`,
      "exec",
      first,
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      "import dns from 'node:dns/promises'; try { await dns.resolve4('example.com'); process.exit(2); } catch { console.log('dns-blocked'); }"
    ],
    { timeout: 10000, maxBuffer: 8192 }
  );
  assert.equal(stdout.trim(), "dns-blocked");
  checks.push({ externalDns: "blocked" });
  const stats = await engine.request("GET", `/containers/${relay}/stats?stream=false`);
  report.relayMemoryBytes = stats.memory_stats.usage;
  report.passed = true;
} finally {
  // Delete only immutable IDs whose labels still match this invocation.
  const failures = [];
  for (const id of containers.reverse()) {
    try {
      const info = await engine.request("GET", `/containers/${id}/json`);
      assert.equal(info.Config.Labels[label], tag);
      await engine.request("DELETE", `/containers/${id}?force=true&v=true`);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const id of networks.reverse()) {
    try {
      const info = await engine.request("GET", `/networks/${id}`);
      assert.equal(info.Labels[label], tag);
      assert.equal(Object.keys(info.Containers ?? {}).length, 0);
      await engine.request("DELETE", `/networks/${id}`);
    } catch (error) {
      failures.push(error);
    }
  }
  const filters = encodeURIComponent(JSON.stringify({ label: [`${label}=${tag}`] }));
  report.remainingContainers = (
    await engine.request("GET", `/containers/json?all=true&filters=${filters}`)
  ).length;
  report.remainingNetworks = (await engine.request("GET", `/networks?filters=${filters}`)).length;
  if (failures.length || report.remainingContainers || report.remainingNetworks)
    report.passed = false;
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: path.join(root, "report.json") }));
  assert.equal(failures.length, 0, "Cleanup failed; inspect labelled resources");
  assert.equal(report.remainingContainers, 0);
  assert.equal(report.remainingNetworks, 0);
}
