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
/** Claude Code launch description: headless stream-json CLI that reaches only the model gateway
 * (Anthropic Messages) and the tool gateway (MCP over HTTP). Measured against CLI 2.1.301; all
 * Claude Code specific settings live in this directory. */
import type { HarnessLaunch, HarnessLaunchConfig, HarnessLauncher } from "../../spi/harness.js";
import {
  CLAUDE_CODE_FILE_FUNCTIONS,
  CLAUDE_CODE_WEB_FUNCTIONS,
  claudeCodeModelFunctions,
  claudeCodeToolName
} from "../../common/builtin-harness.js";
export {
  CLAUDE_CODE_FILE_FUNCTIONS,
  CLAUDE_CODE_WEB_FUNCTIONS,
  claudeCodeModelFunctions,
  claudeCodeToolName
} from "../../common/builtin-harness.js";

const COMMAND = "/usr/local/bin/claude";
const CONFIG_DIR = "/home/runner/.claude";
/** Read by the CLI when it expands `${...}` in the MCP headers, so the capability is not in argv. */
const TOOL_CAPABILITY_ENV = "SANDLANE_TOOL_CAPABILITY";

/** Built-in tools the CLI keeps: `WebSearch` sends one extra model request through the gateway
 * carrying the provider's web search tool (`web_search_20250305`) and returns its summary. The
 * gateway removes it for Runs without web access. (`WebFetch` fetches from inside the sandbox and
 * checks domains with the vendor directly, so it can never work here.) */
/** Built-in tools added in file mode (the Run has conversation files in /workspace): reading
 * files (images and PDFs included), listing and searching them, and running commands such as
 * python3 inside the sandbox. Never offered to Runs without files; the model gateway admits these
 * functions for file-mode Runs only. */
/** Per-Run-independent arguments; the built-in tool list (`--tools`) is added per Run.
 * - `-p` with stream-json in and out: one bidirectional JSONL session per process; partial
 *   messages carry the text deltas, `--verbose` is required for stream-json output.
 * - No `--bare`: it limits built-in tools to Bash/Edit/Read, so WebSearch would be unavailable.
 *   `--restricted` ignores user, project and local settings files (hooks included) instead;
 *   the environment below turns off CLAUDE.md discovery and auto-memory. With ANTHROPIC_API_KEY
 *   set, the CLI authenticates with it (`x-api-key`) in print mode.
 * - `--tools WebSearch` (plus the file tools in file mode) removes every other built-in tool;
 *   `--strict-mcp-config` loads only `--mcp-config`.
 * - `dontAsk` denies anything not allowed explicitly (the default mode asks a classifier, which
 *   costs extra model requests); `--allowedTools` lists the built-in tools and the gateway's.
 * - No session files: the sandbox is discarded after the Run. */
const SESSION_ARGS = Object.freeze([
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--restricted",
  "--strict-mcp-config",
  "--permission-mode",
  "dontAsk",
  "--no-session-persistence"
]);

/** Fixed environment. NONESSENTIAL_TRAFFIC also disables telemetry, error reporting and update
 * checks; the attribution header would add a per-version system block to every request. A
 * couple of CLI retries absorb transient gateway 429s and upstream overload (529). */
const ENV = Object.freeze({
  CLAUDE_CONFIG_DIR: CONFIG_DIR,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  // The thinking-display-updates beta is rejected upstream (400); the CLI then retries without it,
  // which cost a full extra request (~1–1.5s) on every turn.
  CLAUDE_CODE_THINKING_DISPLAY_UPDATES: "0",
  CLAUDE_CODE_MAX_RETRIES: "2",
  // Limit on one MCP tool call; it must outlast the tool gateway's longest call (a client action
  // waits up to 55s for the user's client).
  MCP_TOOL_TIMEOUT: "70000"
});

/** MCP server and tool names as Claude Code shows them to the model: `mcp__<server>__<tool>`,
 * with characters outside [A-Za-z0-9_-] replaced by underscores. */
/** Function names the model gateway admits for a Claude Code Run: the tool gateway's tools,
 * the client action included. */
/** Per-Run arguments and capability environment. The model capability is the API key the CLI
 * sends as `x-api-key`; the tool capability reaches the MCP header through the environment.
 * Web access is not configured here: the gateway enforces each Run's policy. */
export function claudeCodeLaunch(config: HarnessLaunchConfig): HarnessLaunch {
  const identifier = (v: unknown): v is string =>
    typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
  const opaque = (v: unknown): v is string =>
    typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
  const url = (value: string) => {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^[\x21-\x7e]+$/.test(value)
    )
      throw Error();
    return parsed;
  };
  try {
    if (
      !config ||
      !identifier(config.modelAlias) ||
      typeof config.toolServer !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.toolServer) ||
      !opaque(config.modelCapability) ||
      !opaque(config.toolCapability) ||
      config.modelCapability === config.toolCapability ||
      !Array.isArray(config.enabledTools) ||
      config.enabledTools.length < 1 ||
      config.enabledTools.length > 64 ||
      !config.enabledTools.every(identifier) ||
      new Set(config.enabledTools).size !== config.enabledTools.length
    )
      throw Error();
    // The CLI appends /v1/messages itself: pass the origin of the gateway's /v1 base.
    const model = url(config.modelBaseUrl);
    if (!["/", "/v1", "/v1/"].includes(model.pathname)) throw Error();
    const mcp = {
      mcpServers: {
        [config.toolServer]: {
          type: "http",
          url: url(config.mcpUrl).href,
          headers: { Authorization: `Bearer \${${TOOL_CAPABILITY_ENV}}` }
        }
      }
    };
    if (config.fileTools !== undefined && typeof config.fileTools !== "boolean") throw Error();
    const builtIn = [
      ...CLAUDE_CODE_WEB_FUNCTIONS,
      ...(config.fileTools ? CLAUDE_CODE_FILE_FUNCTIONS : [])
    ];
    return {
      args: [
        ...SESSION_ARGS,
        "--tools",
        builtIn.join(","),
        "--model",
        config.modelAlias,
        "--mcp-config",
        JSON.stringify(mcp),
        "--allowedTools",
        // dontAsk denies anything not listed; the file tools run without a prompt.
        [...builtIn, ...claudeCodeModelFunctions(config.toolServer, config.enabledTools)].join(",")
      ],
      env: {
        ANTHROPIC_BASE_URL: model.origin,
        ANTHROPIC_API_KEY: config.modelCapability,
        [TOOL_CAPABILITY_ENV]: config.toolCapability
      }
    };
  } catch {
    throw new Error("Invalid managed Claude Code configuration");
  }
}

/** The Claude Code Driver's launch description for the sandbox. Only CONFIG_DIR (and /tmp,
 * which every sandbox provides) must be writable on a read-only root filesystem. */
export const claudeCodeLauncher: HarnessLauncher = Object.freeze({
  command: COMMAND,
  // Without per-Run configuration: no file tools.
  args: Object.freeze([...SESSION_ARGS, "--tools", CLAUDE_CODE_WEB_FUNCTIONS.join(",")]),
  env: ENV,
  stateDirs: Object.freeze([CONFIG_DIR]),
  configure: claudeCodeLaunch
});
