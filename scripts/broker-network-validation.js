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
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { SandboxBroker } from "../dist/sandbox/docker/lifecycle.js";
import { codexLauncher } from "../dist/harness/codex/codex-managed-config.js";

const image = process.env.DOCKER_TEST_IMAGE;
assert.match(image ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const docker = new DockerEngine(process.env.DOCKER_TEST_SOCKET ?? "");
assert.ok(
  (await docker.request("GET", `/images/${encodeURIComponent(image)}/json`)).RepoDigests.includes(
    image
  )
);
const root = await mkdtemp(
  path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "sandlane-network-recovery-")
);
let fault;
const engine = {
  async request(method, url, body) {
    const removing = method === "DELETE" && url.startsWith("/networks/");
    if (fault === "cleanup" && removing) throw Error("injected unavailable network delete");
    const result = await docker.request(method, url, body);
    if (fault === "create-lost" && url === "/networks/create")
      throw Error("injected lost create reply");
    if (fault === "delete-lost" && removing) throw Error("injected lost delete reply");
    return result;
  }
};
const config = {
  nodeId: `net-${randomUUID()}`,
  harnesses: { codex: { image, launcher: codexLauncher } },
  stateDir: root,
  maxConcurrent: 2,
  perTenant: 1,
  labelPrefix: "validation.sandlane",
  networkMode: "isolated"
};
let broker = new SandboxBroker(engine, config);
const checks = [];
let passed = false;
function spec() {
  const id = randomUUID();
  return {
    schemaVersion: 2,
    harness: "codex",
    allocationId: `a-${id}`,
    runId: `r-${id}`,
    tenantId: "fixture",
    userId: "fixture",
    generation: 1,
    prompt: "No execution in this validation",
    expiresAt: Date.now() + 60000,
    leaseExpiresAt: Date.now() + 30000
  };
}
try {
  await broker.init();
  fault = "create-lost";
  const lostCreate = spec();
  await assert.rejects(broker.allocate(lostCreate));
  fault = undefined;
  assert.equal((await broker.allocate(lostCreate)).state, "failed");
  assert.equal(broker.status().active, 0);
  checks.push("network create reply lost: exact-name ownership cleanup, no recreation");

  const lostDelete = await broker.allocate(spec());
  fault = "delete-lost";
  await assert.rejects(broker.terminate(lostDelete.ref));
  assert.equal(broker.status().active, 1);
  fault = undefined;
  await broker.reconcile();
  assert.equal(broker.status().active, 0);
  checks.push("network delete reply lost: retain slot until reconciliation confirms absence");

  const blocked = await broker.allocate(spec());
  fault = "cleanup";
  await assert.rejects(broker.terminate(blocked.ref));
  assert.equal(broker.status().ready, false);
  assert.equal(broker.status().active, 1);
  fault = undefined;
  broker = new SandboxBroker(engine, { ...config, networkMode: "none" });
  await broker.init();
  assert.equal(broker.status().active, 0);
  assert.equal((await broker.inspect(blocked.ref)).state, "terminated");
  checks.push("restart after cleanup failure: original journal cleans networks even when disabled");
  passed = true;
} finally {
  fault = undefined;
  await broker.shutdown();
  const filter = encodeURIComponent(
    JSON.stringify({ label: [`${config.labelPrefix}.broker=${config.nodeId}`] })
  );
  const remainingContainers = (
    await docker.request("GET", `/containers/json?all=true&filters=${filter}`)
  ).length;
  const remainingNetworks = (await docker.request("GET", `/networks?filters=${filter}`)).length;
  const report = {
    passed: passed && remainingContainers === 0 && remainingNetworks === 0,
    checks,
    image,
    remainingContainers,
    remainingNetworks,
    scope: "Real Docker resources, injected transport failures; no CLI execution or model/MCP calls"
  };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: path.join(root, "report.json") }, null, 2));
  assert.equal(remainingContainers, 0);
  assert.equal(remainingNetworks, 0);
}
