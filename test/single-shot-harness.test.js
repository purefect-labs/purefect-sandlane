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
import { readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  QwenCodeDriver,
  qwenCodeLauncher,
  qwenCodeModelFunctions
} from "../dist/harness/qwen-code/qwen-code.js";
import {
  OpenCodeDriver,
  openCodeLauncher,
  openCodeModelFunctions
} from "../dist/harness/opencode/opencode.js";
import { invocation } from "../deploy/harness-launch-shim.mjs";

const cap = () => randomBytes(32).toString("base64url");
const config = () => ({
  modelAlias: "model-1",
  modelBaseUrl: "https://model.test/v1",
  modelCapability: cap(),
  mcpUrl: "https://tools.test/mcp",
  toolServer: "purefect",
  toolCapability: cap(),
  enabledTools: ["purefect.call", "search"]
});

class FakeTransport {
  observer;
  writes = [];
  stopped = false;
  async start(observer) {
    this.observer = observer;
  }
  async write(frame) {
    this.writes.push(Buffer.from(frame));
  }
  send(value) {
    this.observer.stdout(Buffer.from(`${JSON.stringify(value)}\n`));
  }
  async stop() {
    this.stopped = true;
    return { state: "exited", code: 0, signal: null };
  }
}

test("launch shim is directly executable as a container entrypoint", async () => {
  const shim = new URL("../deploy/harness-launch-shim.mjs", import.meta.url);
  const source = await readFile(shim, "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node\n"), true);

  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-shim-entrypoint-"));
  const entrypoint = path.join(root, "sandlane-harness-shim");
  try {
    await symlink(shim, entrypoint);
    const child = spawn(entrypoint, [], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 125);
    assert.deepEqual(JSON.parse(stdout), {
      _sandlane: { schemaVersion: 1, event: "exit", code: 125, phase: "configuration" }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function input(changes = {}) {
  return {
    runId: "run_1",
    prompt: "hello",
    expiresAt: Date.now() + 60_000,
    ...changes
  };
}

test("Qwen Code driver waits for admission and maps partial text, tools and result", async () => {
  const transport = new FakeTransport();
  const driver = new QwenCodeDriver({ transport });
  const events = [];
  driver.on("event", event => events.push(event));
  let admit;
  const gate = new Promise(resolve => {
    admit = resolve;
  });
  const running = driver.execute(input({ instructions: "trusted", beforeTurn: () => gate }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.writes.length, 0);
  admit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(transport.writes[0]), {
    schemaVersion: 1,
    prompt: "hello",
    instructions: "trusted"
  });
  transport.send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
  });
  transport.send({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool_1", name: "mcp__purefect__search" }
    }
  });
  transport.send({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool_1" }] }
  });
  transport.send({ type: "result", subtype: "success", is_error: false });
  await running;
  assert.deepEqual(
    events.map(event => event.type),
    ["message.delta", "item.started", "item.completed", "run.completed"]
  );
  assert.equal(transport.stopped, true);
});

test("OpenCode driver completes only on the shim exit and preserves a prior error", async () => {
  for (const failed of [false, true]) {
    const transport = new FakeTransport();
    const driver = new OpenCodeDriver({ transport });
    const events = [];
    driver.on("event", event => events.push(event));
    const running = driver.execute(input());
    await new Promise(resolve => setImmediate(resolve));
    transport.send({ type: "text", part: { text: "answer" } });
    if (failed) transport.send({ type: "error", error: { name: "ProviderError" } });
    transport.send({ _sandlane: { schemaVersion: 1, event: "exit", code: 0 } });
    await running;
    assert.deepEqual(
      events.map(event => event.type),
      ["message.delta", failed ? "run.failed" : "run.completed"]
    );
  }
});

test("single-shot failures report a fixed diagnostic phase without native error text", async () => {
  const transport = new FakeTransport();
  const timings = [];
  const driver = new QwenCodeDriver({
    transport,
    onTiming: (_run, phase) => timings.push(phase)
  });
  const running = driver.execute(input());
  await new Promise(resolve => setImmediate(resolve));
  transport.send(Buffer.from("not-json\n"));
  await running;
  assert.ok(timings.includes("failed-harness_protocol"));
});

test("single-shot launchers expose only scoped configuration and reject file mode", () => {
  const qwen = qwenCodeLauncher.configure(config());
  const open = openCodeLauncher.configure(config());
  assert.equal(qwen.env.SANDLANE_SINGLE_SHOT_HARNESS, "qwen-code");
  assert.equal(open.env.SANDLANE_SINGLE_SHOT_HARNESS, "opencode");
  assert.deepEqual(qwenCodeModelFunctions("purefect", ["purefect.call"]), [
    "mcp__purefect__purefect_call"
  ]);
  assert.deepEqual(openCodeModelFunctions("purefect", ["purefect.call"]), [
    "purefect_purefect_call"
  ]);
  assert.equal(qwenCodeLauncher.env.QWEN_HOME, "/home/runner/.qwen");
  assert.ok(qwenCodeLauncher.stateDirs.includes("/home/runner/.qwen"));
  assert.deepEqual(openCodeLauncher.env, {
    HOME: "/home/runner",
    XDG_STATE_HOME: "/home/runner/.local/state",
    XDG_DATA_HOME: "/home/runner/.local/share",
    XDG_CONFIG_HOME: "/home/runner/.config",
    XDG_CACHE_HOME: "/home/runner/.cache"
  });
  assert.ok(openCodeLauncher.stateDirs.includes("/home/runner/.local/share/opencode"));
  assert.ok(openCodeLauncher.stateDirs.includes("/home/runner/.config/opencode"));
  assert.throws(() => qwenCodeLauncher.configure({ ...config(), fileTools: true }), /Invalid/);
  assert.throws(() => openCodeLauncher.configure({ ...config(), fileTools: true }), /Invalid/);
});

test("launch shim writes private managed configs without placing the prompt in child arguments", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    modelBaseUrl: "https://model.test/v1",
    modelAlias: "model-1",
    modelCapability: cap(),
    mcpUrl: "https://tools.test/mcp",
    mcpServer: "purefect",
    mcpCapability: cap(),
    tools: ["purefect.call"]
  };
  const start = {
    schemaVersion: 1,
    prompt: "private prompt",
    instructions: "trusted",
    reasoningEffort: "high"
  };
  const qwen = await invocation({ ...common, harness: "qwen-code" }, start, `${root}/qwen`);
  assert.equal(qwen.command, "/usr/local/bin/qwen");
  assert.equal(qwen.args.includes(start.prompt), false);
  assert.equal(qwen.args.includes("--bare"), true);
  assert.equal(qwen.args.includes("--safe-mode"), false);
  const excludeAt = qwen.args.indexOf("--exclude-tools");
  const maxTurnsAt = qwen.args.indexOf("--max-session-turns");
  assert.deepEqual(qwen.args.slice(excludeAt + 1, maxTurnsAt), [
    "ask_user",
    "edit",
    "glob",
    "grep_search",
    "get_goal",
    "list_directory",
    "notebook_edit",
    "read_file",
    "run_shell_command",
    "save_memory",
    "skill",
    "task",
    "tool_call",
    "tool_search",
    "todo_write",
    "update_goal",
    "web_fetch",
    "web_search",
    "write_file"
  ]);
  assert.equal(qwen.env.QWEN_HOME, `${root}/qwen`);
  assert.equal((await stat(`${root}/qwen/qwen-mcp.json`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${root}/qwen/settings.json`)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(`${root}/qwen/settings.json`, "utf8")), {
    model: { reasoningEffort: "high" }
  });
  const qwenConfig = JSON.parse(await readFile(`${root}/qwen/qwen-mcp.json`, "utf8"));
  assert.equal(
    qwenConfig.mcpServers.purefect.headers.Authorization,
    `Bearer ${common.mcpCapability}`
  );

  const open = await invocation({ ...common, harness: "opencode" }, start, `${root}/open`);
  assert.equal(open.command, "/usr/local/bin/opencode");
  assert.equal(open.args.includes(start.prompt), false);
  const openConfig = JSON.parse(await readFile(`${root}/open/opencode.json`, "utf8"));
  assert.deepEqual(openConfig.permission, { "*": "deny", "purefect_*": "allow" });
  assert.equal(openConfig.agent.sandlane.prompt, "trusted");
  assert.equal(openConfig.agent.title.disable, true);
  assert.equal(openConfig.agent.summary.disable, true);
  assert.equal(openConfig.agent.compaction.disable, true);
  for (const variable of [
    "OPENCODE_PURE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_LSP_DOWNLOAD",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_AUTOUPDATE"
  ])
    assert.equal(open.env[variable], "1");
});
