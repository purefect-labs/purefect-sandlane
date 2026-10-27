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
import {
  codexManagedConfig,
  codexModelFunctions
} from "../dist/harness/codex/codex-managed-config.js";
const config = () => ({
  modelAlias: "analysis",
  modelBaseUrl: "https://model.internal/v1",
  modelCapability: "m".repeat(43),
  mcpUrl: "https://tool.internal/mcp",
  toolServer: "tools",
  toolCapability: "t".repeat(43),
  enabledTools: ["purefect_call", "workspace_action"]
});
test("managed Codex settings use Responses, per-Run env capabilities and no retries", () => {
  const input = config(),
    output = codexManagedConfig(input);
  assert.deepEqual(Object.keys(output.env).sort(), ["SANDLANE_MODEL_CAPABILITY", "SANDLANE_TOOL_CAPABILITY"]);
  assert.ok(output.args.includes('model_providers.sandlane.wire_api="responses"'));
  assert.ok(output.args.includes("model_providers.sandlane.request_max_retries=0"));
  assert.ok(output.args.includes("model_providers.sandlane.stream_max_retries=0"));
  assert.ok(output.args.includes("mcp_servers.tools.required=true"));
  // The page tool is an ordinary MCP tool: listed in enabled_tools, with a call timeout above
  // the gateway's 55s client action wait (Codex defaults to 60s).
  assert.ok(
    output.args.includes('mcp_servers.tools.enabled_tools=["purefect_call","workspace_action"]')
  );
  assert.ok(output.args.includes("mcp_servers.tools.tool_timeout_sec=70"));
  assert.deepEqual(codexModelFunctions("tools", input.enabledTools), [
    "mcp__tools.purefect_call",
    "mcp__tools.workspace_action"
  ]);
  // Always offered; the model gateway keeps, narrows or removes it per Run.
  assert.ok(output.args.includes('web_search="live"'));
  for (const feature of [
    "shell_tool",
    "view_image",
    "multi_agent",
    "apps",
    "plugins",
    "enable_request_compression"
  ])
    assert.ok(output.args.includes(`features.${feature}=false`));
  assert.ok(!output.args.join(" ").includes(input.modelCapability));
  assert.ok(!output.args.join(" ").includes(input.toolCapability));
  input.enabledTools.push("forged");
  input.modelCapability = "x".repeat(43);
  assert.ok(!output.args.join(" ").includes("forged"));
  assert.equal(output.env.SANDLANE_MODEL_CAPABILITY, "m".repeat(43));
});
test("managed Codex settings reject insecure URLs, ambiguous credentials and injected names", () => {
  for (const changes of [
    { modelBaseUrl: "http://model.internal/v1" },
    { mcpUrl: "https://user:pass@tool.internal/mcp" },
    { mcpUrl: "https://tool.internal/mcp?token=secret" },
    { modelAlias: "model\ninjection" },
    { toolServer: "tools.evil" },
    { enabledTools: [] },
    { enabledTools: ["same", "same"] },
    { toolCapability: "m".repeat(43) },
    { modelCapability: "provider-key" }
  ])
    assert.throws(
      () => codexManagedConfig({ ...config(), ...changes }),
      /^Error: Invalid managed Codex configuration$/
    );
});
