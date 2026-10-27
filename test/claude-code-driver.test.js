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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { LocalProcessTransport } from "../dist/harness/codex/local-process-transport.js";
import {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeDriver
} from "../dist/harness/claude-code/claude-code-driver.js";
import {
  claudeCodeLaunch,
  claudeCodeLauncher,
  claudeCodeModelFunctions
} from "../dist/harness/claude-code/claude-code-launcher.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude-code.js", import.meta.url));

/** A Driver over the fake CLI; `log()` returns the stdin lines the CLI received. */
async function fake(t, mode, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-claude-"));
  const file = path.join(root, "stdin.jsonl");
  const transport = new LocalProcessTransport({
    command: process.execPath,
    args: [FAKE],
    home: path.join(root, "home"),
    workspace: root,
    env: { FAKE_MODE: mode, FAKE_LOG: file }
  });
  const driver = new ClaudeCodeDriver({ transport, ...options });
  const events = [];
  driver.on("event", event => events.push(event));
  t.after(async () => {
    await driver.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const log = async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  return { driver, events, log };
}

function input(changes = {}) {
  return {
    runId: "run-1",
    prompt: "Hello there",
    expiresAt: Date.now() + 60_000,
    ...changes
  };
}

const kinds = events => events.map(event => event.type);

test("a turn: system prompt and effort over control requests, admission gate, then one user message", async t => {
  const { driver, events, log } = await fake(t, "text", { reasoningEffort: "medium" });
  let atAdmission;
  await driver.execute(
    input({
      instructions: "Business instructions.",
      contextData: ["Saved memory."],
      reasoningEffort: "low",
      beforeTurn: async () => {
        atAdmission = (await log()).map(line => line.request?.subtype ?? line.type);
      }
    })
  );
  assert.deepEqual(atAdmission, ["initialize", "apply_flag_settings"]);
  const lines = await log();
  assert.deepEqual(lines[0].request, {
    subtype: "initialize",
    systemPrompt: ["Business instructions."]
  });
  assert.deepEqual(lines[1].request, {
    subtype: "apply_flag_settings",
    settings: { effortLevel: "low" }
  });
  assert.equal(lines[2].type, "user");
  assert.deepEqual(lines[2].message.content, [
    { type: "text", text: "Saved memory." },
    { type: "text", text: "Hello there" }
  ]);
  assert.equal(lines.length, 3);
  assert.deepEqual(kinds(events), ["message.delta", "message.delta", "run.completed"]);
  assert.equal(events.map(e => e.data.delta ?? "").join(""), "Hello");
  assert.deepEqual(events.at(-1).data, { usage: { input_tokens: 16, output_tokens: 5 } });
  assert.deepEqual(
    events.map(e => e.sequence),
    [1, 2, 3]
  );
  assert.equal(driver.stopEvidence.state, "exited");
});

test("tool activity becomes sanitized item events; subagent text and CLI permission requests are not passed on", async t => {
  const { driver, events, log } = await fake(t, "tool");
  await driver.execute(input());
  assert.deepEqual(kinds(events), [
    "message.delta",
    "item.started",
    "item.completed",
    "message.delta",
    "run.completed"
  ]);
  const item = {
    type: "mcpToolCall",
    id: "toolu_1",
    server: "tools",
    tool: "metadata_get_raw",
    arguments: { api_code: "a.b" }
  };
  assert.deepEqual(events[1].data.item, { ...item, status: "inProgress" });
  assert.deepEqual(events[2].data.item, { ...item, status: "completed" });
  assert.equal(events.map(e => e.data.delta ?? "").join(""), "Checking. Done.");
  assert.ok(!JSON.stringify(events).includes("secret"), "tool results never leave the Driver");
  const refusal = (await log()).find(line => line.type === "control_response");
  assert.deepEqual(refusal.response, {
    subtype: "error",
    request_id: "cli-1",
    error: "Not supported"
  });
});

test("WebSearch becomes a sanitized web search activity: clipped query, never results", async t => {
  const { driver, events } = await fake(t, "web-search");
  await driver.execute(input());
  assert.deepEqual(kinds(events), [
    "item.started",
    "item.completed",
    "message.delta",
    "run.completed"
  ]);
  const item = {
    type: "webSearch",
    id: "toolu_ws",
    title: "联网搜索",
    query: "latest release notes"
  };
  assert.deepEqual(events[0].data.item, { ...item, status: "inProgress" });
  assert.deepEqual(events[1].data.item, { ...item, status: "completed" });
  assert.ok(!JSON.stringify(events).includes("secret"), "search results never leave the Driver");
});

test("a built-in tool other than the gateway-governed WebSearch fails the Run at session start", async t => {
  const { driver, events } = await fake(t, "foreign-tool");
  await driver.execute(input());
  assert.deepEqual(kinds(events), ["run.failed"]);
});

test("an error result fails the Run with the CLI's classification and no streamed text", async t => {
  const { driver, events } = await fake(t, "error");
  await driver.execute(input());
  assert.deepEqual(kinds(events), ["run.failed"]);
  assert.equal(events[0].data.code, "HARNESS_API_ERROR");
});

test("an MCP server that did not connect fails the Run at session start", async t => {
  const { driver, events } = await fake(t, "mcp-failed");
  await driver.execute(input());
  assert.deepEqual(kinds(events), ["run.failed"]);
  assert.equal(events[0].data.code, "HARNESS_FAILURE");
});

test("cancel interrupts the running turn, waits for its result and stops the CLI", async t => {
  const { driver, events, log } = await fake(t, "slow", { interruptGraceMs: 5_000 });
  const running = driver.execute(input());
  while (!events.some(e => e.type === "message.delta"))
    await new Promise(resolve => setTimeout(resolve, 10));
  await driver.cancel();
  await running;
  assert.equal(events.at(-1).type, "run.cancelled");
  assert.equal(kinds(events).filter(k => k.startsWith("run.")).length, 1);
  assert.ok((await log()).some(line => line.request?.subtype === "interrupt"));
  assert.equal(driver.stopEvidence.state, "exited");
});

test("capabilities: Anthropic Messages, ephemeral; tools only through the gateway", () => {
  assert.equal(new ClaudeCodeDriver({ transport: {} }).capabilities, CLAUDE_CODE_CAPABILITIES);
  assert.equal(Object.isFrozen(CLAUDE_CODE_CAPABILITIES), true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.modelWire, "anthropic-messages");
  // The page tool is an MCP tool of the gateway like any other: no Driver-side tool bridge.
  assert.equal("clientActions" in CLAUDE_CODE_CAPABILITIES, false);
  assert.equal(CLAUDE_CODE_CAPABILITIES.sessionPolicy, "ephemeral");
  assert.throws(() => new ClaudeCodeDriver({ transport: {}, reasoningEffort: "max" }));
});

test("launch description: gateway-only CLI, capabilities in the environment, model origin without /v1", () => {
  const config = {
    modelAlias: "sandlane",
    modelBaseUrl: "https://model.internal:9443/v1",
    mcpUrl: "https://mcp.internal:9444/mcp",
    toolServer: "tools",
    modelCapability: "m".repeat(43),
    toolCapability: "t".repeat(43),
    enabledTools: ["purefect_call", "read_api_doc", "workspace_action"]
  };
  const launch = claudeCodeLaunch(config);
  for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"])
    assert.ok(launch.args.includes(flag), flag);
  // --bare limits built-in tools to Bash/Edit/Read (measured on 2.1.301): WebSearch needs it off.
  assert.ok(!launch.args.includes("--bare"));
  const value = flag => launch.args[launch.args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "WebSearch");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--model"), "sandlane");
  assert.equal(
    value("--allowedTools"),
    "WebSearch,mcp__tools__purefect_call,mcp__tools__read_api_doc,mcp__tools__workspace_action"
  );
  assert.deepEqual(JSON.parse(value("--mcp-config")), {
    mcpServers: {
      tools: {
        type: "http",
        url: "https://mcp.internal:9444/mcp",
        headers: { Authorization: "Bearer ${SANDLANE_TOOL_CAPABILITY}" }
      }
    }
  });
  assert.deepEqual(launch.env, {
    ANTHROPIC_BASE_URL: "https://model.internal:9443",
    ANTHROPIC_API_KEY: config.modelCapability,
    SANDLANE_TOOL_CAPABILITY: config.toolCapability
  });
  assert.ok(!launch.args.join(" ").includes("t".repeat(43)), "no capability in argv");
  assert.deepEqual(claudeCodeLauncher.stateDirs, ["/home/runner/.claude"]);
  for (const name of [
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS"
  ])
    assert.equal(claudeCodeLauncher.env[name], "1", name);
  // A page action waits up to 55s for the browser; the CLI must not give up first.
  assert.equal(claudeCodeLauncher.env.MCP_TOOL_TIMEOUT, "70000");
  assert.deepEqual(claudeCodeModelFunctions("tools", ["metadata.get_raw", "workspace_action"]), [
    "mcp__tools__metadata_get_raw",
    "mcp__tools__workspace_action"
  ]);
  for (const change of [
    { modelBaseUrl: "http://model.internal/v1" },
    { modelBaseUrl: "https://model.internal/v2" },
    { toolCapability: config.modelCapability },
    { enabledTools: [] },
    { toolServer: "bad server" }
  ])
    assert.throws(() => claudeCodeLaunch({ ...config, ...change }), /Claude Code configuration/);
});
