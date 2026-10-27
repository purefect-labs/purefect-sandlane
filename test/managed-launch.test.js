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
import test from "node:test";
import {
  parseGatewayPolicy,
  parseRunAuthorization,
  managedLaunch
} from "../dist/sandbox/docker/managed-launch.js";
import { codexLauncher } from "../dist/harness/codex/codex-managed-config.js";

test("Gateway policy requires fixed HTTPS DNS names and no credentials, query or extra options", () => {
  const policy = { modelBaseUrl: "https://model.test/v1", mcpUrl: "https://mcp.test/mcp" };
  assert.ok(Object.isFrozen(parseGatewayPolicy(policy)));
  for (const modelBaseUrl of [
    "http://model.test",
    "https://127.0.0.1/v1",
    "https://user:pass@model.test",
    "https://model.test?token=x",
    "https://model.test/#x",
    "https://bad..test"
  ]) {
    assert.throws(() => parseGatewayPolicy({ ...policy, modelBaseUrl }), {
      code: "INVALID_GATEWAY_POLICY"
    });
  }
  assert.throws(() => parseGatewayPolicy({ ...policy, env: {} }));
});

test("authorization snapshot cannot be retargeted and capabilities never appear in command arguments", () => {
  const expiry = Date.now() + 60000;
  const raw = {
    modelAlias: "model",
    toolServer: "tools",
    enabledTools: ["read"],
    model: { value: "m".repeat(43), expiresAt: expiry },
    tool: { value: "t".repeat(43), expiresAt: expiry }
  };
  const auth = parseRunAuthorization(raw, expiry, Date.now());
  raw.enabledTools.push("write");
  raw.model.value = "x".repeat(43);
  const policy = parseGatewayPolicy({
    modelBaseUrl: "https://gateway.test:9443/v1",
    mcpUrl: "https://gateway.test:9444/mcp"
  });
  const launch = managedLaunch(policy, auth, "172.20.0.1", codexLauncher);
  assert.deepEqual(auth.enabledTools, ["read"]);
  assert.ok(!JSON.stringify(launch.args).includes(auth.model.value));
  assert.deepEqual(launch.extraHosts, ["gateway.test:172.20.0.1"]);
  assert.equal(launch.args.at(-1), "app-server");
  assert.ok(launch.args.includes('mcp_servers.tools.required=true'));
  assert.throws(() => managedLaunch(policy, auth, "host.docker.internal", codexLauncher));
  assert.throws(() => parseRunAuthorization(raw, expiry, expiry));
});
