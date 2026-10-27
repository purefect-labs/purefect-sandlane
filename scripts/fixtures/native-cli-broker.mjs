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
/** Disposable Broker/Relay composition for the native CLI Gateway acceptance script. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { codexLauncher } from "../../dist/harness/codex/codex-managed-config.js";
import { SandboxBroker } from "../../dist/sandbox/docker/lifecycle.js";
import { createBrokerServer, listenUnix } from "../../dist/sandbox/docker/server.js";
import { BrokerClient } from "../../dist/sandbox/docker/client.js";
import { BrokerHarnessTransport } from "../../dist/sandbox/docker/broker-transport.js";

const LABEL_PREFIX = "validation.sandlane";
/** MCP server name the fixture gateways register the Purefect catalog under. */
const TOOL_SERVER = "purefect";

export async function startNativeCliBroker({
  docker,
  image,
  relayImage,
  network,
  upstreamIp,
  root,
  nodeId,
  containers
}) {
  assert.match(relayImage ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
  const metadata = await docker.request("GET", `/images/${encodeURIComponent(image)}/json`);
  const pinnedImage = metadata.RepoDigests?.[0];
  assert.ok(pinnedImage, "Derived CLI image needs a local RepoDigest");
  const relayMetadata = await docker.request(
    "GET",
    `/images/${encodeURIComponent(relayImage)}/json`
  );
  assert.ok(relayMetadata.RepoDigests.includes(relayImage));
  const routes = JSON.stringify(
    [9443, 9444].map(port => ({
      listenHost: "0.0.0.0",
      listenPort: port,
      upstreamHost: upstreamIp,
      upstreamPort: port
    }))
  );
  const policyDigest = createHash("sha256").update(routes).digest("hex");
  const relay = await docker.request("POST", "/containers/create", {
    Image: relayImage,
    User: "1000:1000",
    Entrypoint: ["/usr/local/bin/node"],
    Cmd: ["/app/bin/relay.js"],
    Env: [`SANDLANE_RELAY_ROUTES=${routes}`],
    Labels: {
      [`${LABEL_PREFIX}.relay.node`]: nodeId,
      [`${LABEL_PREFIX}.relay.policy`]: policyDigest
    },
    HostConfig: {
      NetworkMode: network,
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
  containers.push(relay.Id);
  await docker.request("POST", `/containers/${relay.Id}/start`);
  const broker = new SandboxBroker(docker, {
    nodeId,
    harnesses: { codex: { image: pinnedImage, launcher: codexLauncher } },
    stateDir: path.join(root, "broker"),
    maxConcurrent: 2,
    perTenant: 1,
    labelPrefix: LABEL_PREFIX,
    networkMode: "isolated",
    relay: { containerId: relay.Id, imageId: relayMetadata.Id, policyDigest },
    managedGateways: {
      modelBaseUrl: "https://gateway.test:9443/v1",
      mcpUrl: "https://gateway.test:9444/mcp"
    },
  });
  const token = randomBytes(32).toString("base64url");
  const server = createBrokerServer(broker, token);
  const socket = path.join(root, "broker.sock");
  try {
    await broker.init();
    await listenUnix(server, socket);
  } catch (error) {
    await broker.shutdown();
    throw error;
  }
  const client = new BrokerClient(socket, token);
  const networks = new Set();
  return {
    async transport(user, expiresAt) {
      const spec = {
        schemaVersion: 2,
        harness: "codex",
        allocationId: `allocation-${user.id}`,
        runId: `run-${user.id}`,
        tenantId: user.id,
        userId: user.id,
        generation: 1,
        prompt: "Read fixture metadata",
        expiresAt,
        leaseExpiresAt: Math.min(expiresAt, Date.now() + 30000)
      };
      const allocated = await client.allocateManaged(spec, {
        modelAlias: "fixture",
        toolServer: TOOL_SERVER,
        enabledTools: [user.id === "b" ? "metadata.get_meta" : "metadata.get_raw"],
        model: { value: user.model, expiresAt },
        tool: { value: user.tool, expiresAt }
      });
      assert.ok(!networks.has(allocated.networkId), "Run networks must be independent");
      networks.add(allocated.networkId);
      const info = await docker.request("GET", `/containers/${allocated.containerName}/json`);
      assert.equal(info.State.Running, false);
      assert.equal(info.HostConfig.Binds?.length ?? 0, 0);
      return new BrokerHarnessTransport(client, {
        ref: allocated.ref,
        userId: user.id,
        expiresAt,
        nodeId
      });
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await broker.shutdown();
      for (const networkId of networks) {
        await assert.rejects(
          docker.request("GET", `/networks/${networkId}`),
          error => error.status === 404
        );
      }
      return { independentRunNetworks: networks.size };
    }
  };
}
