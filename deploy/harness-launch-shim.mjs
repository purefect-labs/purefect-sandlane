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
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const START_LIMIT = 128 * 1024;
const TEXT_LIMIT = 100_000;
const INSTRUCTIONS_LIMIT = 16_000;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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
    tools: Object.freeze(tools)
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
        "--no-chat-recording",
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
      }
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
      ...(start.reasoningEffort ? ["--variant", start.reasoningEffort] : [])
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
    }
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

export async function main() {
  let code = 125;
  let phase = "configuration";
  let endedWithNewline = true;
  try {
    const config = environment();
    phase = "start-frame";
    const start = await oneLine(process.stdin);
    phase = "invocation";
    const launch = await invocation(config, start, MANAGED_ROOTS[config.harness]);
    phase = "spawn";
    const child = spawn(launch.command, launch.args, {
      cwd: "/workspace",
      env: childEnvironment(launch.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    phase = "child";
    child.stdout.on("data", chunk => {
      const bytes = Buffer.from(chunk);
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
  } catch {
    code = 125;
  }
  if (!endedWithNewline) process.stdout.write("\n");
  process.stdout.write(
    `${JSON.stringify({ _sandlane: { schemaVersion: 1, event: "exit", code, phase } })}\n`
  );
  process.exitCode = code;
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url))
  await main();
