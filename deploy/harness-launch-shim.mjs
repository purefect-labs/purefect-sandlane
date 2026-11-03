#!/usr/bin/env node
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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const START_LIMIT = 128 * 1024;
const TEXT_LIMIT = 100_000;
const INSTRUCTIONS_LIMIT = 16_000;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPENCODE_ID = /^ses_[A-Za-z0-9]{12,64}$/;
const STATE_LIMIT = 1024 * 1024;
const MANAGED_ROOTS = Object.freeze({
  "qwen-code": "/home/runner/.qwen/sandlane",
  opencode: "/home/runner/.config/opencode/sandlane"
});
const QWEN_CORE_TOOLS = Object.freeze([
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

function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

function required(env, key, pattern, limit = 4096) {
  const value = env[key];
  if (typeof value !== "string" || !value || value.length > limit || !pattern.test(value))
    throw new Error("SHIM_CONFIGURATION");
  return value;
}

function endpoint(env, key) {
  const value = required(env, key, /^[\x21-\x7e]+$/, 2048);
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("SHIM_CONFIGURATION");
  return parsed.href;
}

function nativeSession(raw, harness) {
  const value = raw.SANDLANE_NATIVE_SESSION;
  if (value === undefined) return undefined;
  if (value === "cold") return Object.freeze({ mode: "cold" });
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SHIM_CONFIGURATION");
  }
  if (!exact(parsed, ["kind", "threadId", "path"])) throw new Error("SHIM_CONFIGURATION");
  const expected = harness === "qwen-code" ? "qwen-session-v1" : "opencode-export-v1";
  const valid =
    expected === "qwen-session-v1"
      ? UUID.test(parsed.threadId) &&
        parsed.path ===
          `/home/runner/.qwen/sandlane/projects/-workspace/chats/${parsed.threadId}.jsonl`
      : OPENCODE_ID.test(parsed.threadId) &&
        parsed.path ===
          `/home/runner/.local/state/opencode/sandlane/native/${parsed.threadId}.json`;
  if (parsed.kind !== expected || typeof parsed.path !== "string" || !valid)
    throw new Error("SHIM_CONFIGURATION");
  return Object.freeze({ mode: "resume", thread: Object.freeze({ ...parsed }) });
}

function environment(raw = process.env) {
  const harness = required(raw, "SANDLANE_SINGLE_SHOT_HARNESS", /^(qwen-code|opencode)$/);
  const toolsRaw = required(raw, "SANDLANE_MCP_TOOLS", /^[\x20-\x7e]+$/, 16_000);
  let tools;
  try {
    tools = JSON.parse(toolsRaw);
  } catch {
    throw new Error("SHIM_CONFIGURATION");
  }
  if (
    !Array.isArray(tools) ||
    tools.length < 1 ||
    tools.length > 64 ||
    tools.some(tool => typeof tool !== "string" || !IDENTIFIER.test(tool)) ||
    new Set(tools).size !== tools.length
  )
    throw new Error("SHIM_CONFIGURATION");
  return Object.freeze({
    harness,
    modelBaseUrl: endpoint(raw, "SANDLANE_MODEL_BASE_URL"),
    modelAlias: required(raw, "SANDLANE_MODEL_ALIAS", IDENTIFIER),
    modelCapability: required(raw, "SANDLANE_MODEL_CAPABILITY", CAPABILITY),
    mcpUrl: endpoint(raw, "SANDLANE_MCP_URL"),
    mcpServer: required(raw, "SANDLANE_MCP_SERVER", SERVER),
    mcpCapability: required(raw, "SANDLANE_MCP_CAPABILITY", CAPABILITY),
    tools: Object.freeze(tools),
    nativeSession: nativeSession(raw, harness)
  });
}

function startFrame(value) {
  const keys = ["schemaVersion", "prompt"];
  if (value?.instructions !== undefined) keys.push("instructions");
  if (value?.reasoningEffort !== undefined) keys.push("reasoningEffort");
  if (!exact(value, keys) || value.schemaVersion !== 1) throw new Error("SHIM_START_FRAME");
  if (
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    Buffer.byteLength(value.prompt) > TEXT_LIMIT ||
    (value.instructions !== undefined &&
      (typeof value.instructions !== "string" ||
        Buffer.byteLength(value.instructions) > INSTRUCTIONS_LIMIT)) ||
    (value.reasoningEffort !== undefined &&
      !["low", "medium", "high"].includes(value.reasoningEffort))
  )
    throw new Error("SHIM_START_FRAME");
  return Object.freeze({ ...value });
}

async function oneLine(input) {
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let buffered = "";
    let settled = false;
    const cleanup = () => {
      input.off("data", receive);
      input.off("end", fail);
      input.off("error", fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("SHIM_START_FRAME"));
    };
    const receive = chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > START_LIMIT) return fail();
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      cleanup();
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      try {
        resolve(startFrame(JSON.parse(line)));
      } catch {
        reject(new Error("SHIM_START_FRAME"));
      }
    };
    input.on("data", receive);
    input.once("end", fail);
    input.once("error", fail);
  });
}

async function secureJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await chmod(path, 0o600);
}

export async function invocation(config, start, root = "/tmp/sandlane-harness") {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  if (config.harness === "qwen-code") {
    const mcp = `${root}/qwen-mcp.json`;
    const settings = `${root}/settings.json`;
    await secureJson(settings, {
      ...(start.reasoningEffort ? { model: { reasoningEffort: start.reasoningEffort } } : {})
    });
    await secureJson(mcp, {
      mcpServers: {
        [config.mcpServer]: {
          httpUrl: config.mcpUrl,
          headers: { Authorization: `Bearer ${config.mcpCapability}` },
          includeTools: [...config.tools],
          trust: true,
          timeout: 70_000
        }
      }
    });
    const allowed = config.tools.map(
      tool => `mcp__${config.mcpServer}__${tool.replaceAll(".", "_")}`
    );
    const sessionId = config.nativeSession
      ? config.nativeSession.mode === "resume"
        ? config.nativeSession.thread.threadId
        : randomUUID()
      : undefined;
    return {
      command: "/usr/local/bin/qwen",
      args: [
        "--bare",
        "--auth-type",
        "openai-responses",
        "--model",
        config.modelAlias,
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        ...(sessionId
          ? config.nativeSession.mode === "resume"
            ? ["--resume", sessionId]
            : ["--chat-recording", "--session-id", sessionId]
          : ["--no-chat-recording"]),
        "--no-telemetry",
        "--mcp-config",
        mcp,
        "--allowed-mcp-server-names",
        config.mcpServer,
        "--allowed-tools",
        ...allowed,
        "--exclude-tools",
        ...QWEN_CORE_TOOLS,
        "--max-session-turns",
        "64",
        "--max-tool-calls",
        "64",
        "--max-wall-time",
        "25m",
        ...(start.instructions ? ["--system-prompt", start.instructions] : [])
      ],
      env: {
        OPENAI_API_KEY: config.modelCapability,
        OPENAI_BASE_URL: config.modelBaseUrl,
        OPENAI_MODEL: config.modelAlias,
        QWEN_HOME: root,
        QWEN_CODE_NO_UPDATE_NOTIFIER: "1",
        QWEN_CODE_DISABLE_TELEMETRY: "1"
      },
      ...(sessionId
        ? {
            expectedVersion: "0.26.3",
            nativeThread: {
              kind: "qwen-session-v1",
              threadId: sessionId,
              path: `${root}/projects/-workspace/chats/${sessionId}.jsonl`
            }
          }
        : {})
    };
  }

  const file = `${root}/opencode.json`;
  const toolPattern = `${config.mcpServer}_*`;
  await secureJson(file, {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: `openai/${config.modelAlias}`,
    provider: {
      openai: {
        options: { apiKey: config.modelCapability, baseURL: config.modelBaseUrl },
        models: { [config.modelAlias]: { name: config.modelAlias } }
      }
    },
    mcp: {
      [config.mcpServer]: {
        type: "remote",
        url: config.mcpUrl,
        oauth: false,
        headers: { Authorization: `Bearer ${config.mcpCapability}` },
        timeout: 70_000,
        enabled: true
      }
    },
    permission: { "*": "deny", [toolPattern]: "allow" },
    agent: {
      title: { disable: true },
      summary: { disable: true },
      compaction: { disable: true },
      sandlane: {
        mode: "primary",
        description: "SandLane managed single-Run agent",
        ...(start.instructions ? { prompt: start.instructions } : {}),
        permission: { "*": "deny", [toolPattern]: "allow" }
      }
    }
  });
  return {
    command: "/usr/local/bin/opencode",
    args: [
      "run",
      "--format",
      "json",
      "--model",
      `openai/${config.modelAlias}`,
      "--agent",
      "sandlane",
      ...(start.reasoningEffort ? ["--variant", start.reasoningEffort] : []),
      ...(config.nativeSession?.mode === "resume"
        ? ["--session", config.nativeSession.thread.threadId]
        : [])
    ],
    env: {
      OPENCODE_CONFIG: file,
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_TERMINAL_TITLE: "1",
      OPENCODE_PERMISSION: JSON.stringify({ "*": "deny", [toolPattern]: "allow" })
    },
    ...(config.nativeSession
      ? {
          expectedVersion: "1.19.5",
          nativeThread:
            config.nativeSession.mode === "resume" ? config.nativeSession.thread : undefined,
          nativeRoot: "/home/runner/.local/state/opencode/sandlane/native"
        }
      : {})
  };
}

function childEnvironment(additions) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("SANDLANE_")
    )
  );
  return { ...env, ...additions };
}

async function collect(command, args, env, limit = STATE_LIMIT) {
  const child = spawn(command, args, {
    cwd: "/workspace",
    env: childEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > limit) {
      exceeded = true;
      child.kill("SIGKILL");
    } else chunks.push(Buffer.from(chunk));
  });
  child.stderr.resume();
  const code = await new Promise(resolve => {
    child.once("error", () => resolve(125));
    child.once("exit", value => resolve(Number.isSafeInteger(value) ? value : 125));
  });
  return { code, stdout: Buffer.concat(chunks), exceeded };
}

async function verifyVersion(launch) {
  if (!launch.expectedVersion) return;
  const result = await collect(launch.command, ["--version"], launch.env, 4096);
  const version = result.stdout.toString("utf8").trim().replace(/^v/, "");
  if (result.code !== 0 || result.exceeded || version !== launch.expectedVersion)
    throw new Error("SHIM_VERSION");
}

function opencodeSessionTracker() {
  let buffer = Buffer.alloc(0);
  let sessionId;
  let invalid = false;
  const inspect = (value, depth = 0) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "sessionID" && typeof child === "string" && OPENCODE_ID.test(child)) {
        if (sessionId && sessionId !== child) invalid = true;
        sessionId = child;
      } else inspect(child, depth + 1);
    }
  };
  return {
    consume(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          inspect(JSON.parse(line));
        } catch {}
      }
      if (buffer.length > STATE_LIMIT) {
        invalid = true;
        buffer = Buffer.alloc(0);
      }
    },
    id() {
      return invalid ? undefined : sessionId;
    }
  };
}

async function prepareNative(launch) {
  await verifyVersion(launch);
  if (launch.nativeThread?.kind !== "opencode-export-v1") return;
  const imported = await collect(launch.command, ["import", launch.nativeThread.path], launch.env);
  if (imported.code !== 0 || imported.exceeded) throw new Error("SHIM_IMPORT");
}

async function finishNative(launch, tracker) {
  if (launch.nativeThread?.kind === "qwen-session-v1") return launch.nativeThread;
  if (!launch.nativeRoot) return undefined;
  const sessionId = tracker.id();
  if (!sessionId || (launch.nativeThread && launch.nativeThread.threadId !== sessionId))
    throw new Error("SHIM_SESSION");
  const exported = await collect(launch.command, ["export", sessionId], launch.env);
  if (exported.code !== 0 || exported.exceeded || !exported.stdout.length)
    throw new Error("SHIM_EXPORT");
  JSON.parse(exported.stdout.toString("utf8"));
  await mkdir(launch.nativeRoot, { recursive: true, mode: 0o700 });
  const path = `${launch.nativeRoot}/${sessionId}.json`;
  const pending = `${path}.pending`;
  try {
    await writeFile(pending, exported.stdout, { mode: 0o600, flag: "wx" });
    await chmod(pending, 0o600);
    await rename(pending, path);
  } catch (error) {
    await rm(pending, { force: true }).catch(() => {});
    throw error;
  }
  return { kind: "opencode-export-v1", threadId: sessionId, path };
}

export async function main() {
  let code = 125;
  let phase = "configuration";
  let endedWithNewline = true;
  let nativeThread;
  try {
    const config = environment();
    phase = "start-frame";
    const start = await oneLine(process.stdin);
    phase = "invocation";
    const launch = await invocation(config, start, MANAGED_ROOTS[config.harness]);
    await prepareNative(launch);
    phase = "spawn";
    const tracker = opencodeSessionTracker();
    const child = spawn(launch.command, launch.args, {
      cwd: "/workspace",
      env: childEnvironment(launch.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    phase = "child";
    child.stdout.on("data", chunk => {
      const bytes = Buffer.from(chunk);
      if (config.harness === "opencode" && config.nativeSession) tracker.consume(bytes);
      if (bytes.length) endedWithNewline = bytes[bytes.length - 1] === 10;
      process.stdout.write(bytes);
    });
    // Diagnostics stay inside the sandbox; drain stderr so a verbose CLI cannot deadlock.
    child.stderr.resume();
    child.stdin.end(start.prompt);
    code = await new Promise(resolve => {
      child.once("error", () => resolve(125));
      child.once("exit", value => resolve(Number.isSafeInteger(value) ? value : 125));
    });
    if (code === 0 && config.nativeSession) nativeThread = await finishNative(launch, tracker);
  } catch {
    code = 125;
  }
  if (!endedWithNewline) process.stdout.write("\n");
  process.stdout.write(
    `${JSON.stringify({
      _sandlane: {
        schemaVersion: 1,
        event: "exit",
        code,
        phase,
        ...(code === 0 && nativeThread ? { nativeSession: nativeThread } : {})
      }
    })}\n`
  );
  process.exitCode = code;
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url))
  await main();
