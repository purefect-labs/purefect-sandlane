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
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeArguments,
  discoverConfigDir,
  parseEnvironment,
  privateWrite,
  relayEnvironment,
  resolveDeployment,
  statusEndpoint
} from "../scripts/server-deployment-lib.js";

test("config discovery prefers explicit and neutral locations while retaining legacy compatibility", () => {
  const files = new Set(["/etc/purefect/sandlane/runtime.env"]);
  const exists = file => files.has(file);
  assert.equal(discoverConfigDir({ explicit: "/srv/sl", environment: {}, exists }), "/srv/sl");
  assert.equal(
    discoverConfigDir({ environment: { SANDLANE_SERVER_CONFIG_DIR: "/srv/env" }, exists }),
    "/srv/env"
  );
  assert.equal(discoverConfigDir({ environment: {}, exists }), "/etc/purefect/sandlane");
  files.add("/etc/sandlane/runtime.env");
  assert.equal(discoverConfigDir({ environment: {}, exists }), "/etc/sandlane");
});

test("environment parsing preserves JSON and relay routes are deterministic", () => {
  const environment = parseEnvironment(`
# comment
SANDLANE_WORKER_IP=172.30.0.2
SANDLANE_MODEL_GATEWAY_PORT=19443
SANDLANE_TOOL_MCP_PORT=19444
RUNTIME_CLI_IMAGES={"codex":"image@sha256:abc"}
`);
  assert.equal(environment.get("RUNTIME_CLI_IMAGES"), '{"codex":"image@sha256:abc"}');
  const relay = relayEnvironment(environment);
  const parsed = parseEnvironment(relay);
  const routes = JSON.parse(parsed.get("SANDLANE_RELAY_ROUTES"));
  assert.deepEqual(
    routes.map(route => route.upstreamPort),
    [19443, 19444]
  );
  assert.ok(/^[a-f0-9]{64}$/.test(parsed.get("SANDLANE_RELAY_POLICY_DIGEST")));
  assert.equal(statusEndpoint(environment), undefined);
  environment.set("SANDLANE_STATUS_PORT", "19445");
  assert.equal(statusEndpoint(environment), "http://127.0.0.1:19445/status.json");
  environment.set("SANDLANE_STATUS_PORT", "19445/path");
  assert.throws(() => statusEndpoint(environment), /Status port/);
});

test("deployment arguments keep secrets outside commands and allow composition replacement", () => {
  const deployment = resolveDeployment({
    root: "/opt/sandlane",
    configDir: "/etc/sandlane",
    project: "sandlane-test",
    composeFiles: ["/srv/base.yaml", "/srv/control-plane.yaml"],
    exists: () => false
  });
  assert.deepEqual(deployment.composeFiles, ["/srv/base.yaml", "/srv/control-plane.yaml"]);
  assert.deepEqual(composeArguments(deployment), [
    "compose",
    "-p",
    "sandlane-test",
    "--env-file",
    "/etc/sandlane/runtime.env",
    "--env-file",
    "/etc/sandlane/relay.env",
    "--env-file",
    "/etc/sandlane/binding.env",
    "-f",
    "/srv/base.yaml",
    "-f",
    "/srv/control-plane.yaml"
  ]);
});

test("private deployment files are atomically replaced with mode 0600", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sandlane-server-test-"));
  const file = path.join(directory, "binding.env");
  await privateWrite(file, "SANDLANE_BROKER_RELAY_BINDING={}\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, "utf8"), "SANDLANE_BROKER_RELAY_BINDING={}\n");
  await privateWrite(file, 'SANDLANE_BROKER_RELAY_BINDING={"v":2}\n');
  assert.equal(await readFile(file, "utf8"), 'SANDLANE_BROKER_RELAY_BINDING={"v":2}\n');
});
