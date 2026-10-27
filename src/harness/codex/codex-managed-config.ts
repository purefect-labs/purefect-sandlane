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
import type { HarnessLaunch, HarnessLaunchConfig, HarnessLauncher } from "../../spi/harness.js";

/** Host-owned per-Run configuration. These are scoped Gateway capabilities, NEVER provider keys,
 * user PATs or node service credentials. Gateway endpoints must be operator-pinned and implement
 * Responses / Streamable HTTP MCP respectively; the text validation server is not compatible. */
export type CodexManagedConfig = HarnessLaunchConfig;

/** Provider name of the model gateway in the generated Codex configuration. */
const PROVIDER = "sandlane";
const MODEL_CAPABILITY_ENV = "SANDLANE_MODEL_CAPABILITY";
const TOOL_CAPABILITY_ENV = "SANDLANE_TOOL_CAPABILITY";
/** Codex's own limit on one MCP tool call (its default is 60s). It must outlast the tool gateway's
 * longest call: a client action waits up to 55s for the user's client. */
const TOOL_TIMEOUT_SEC = 70;

/** Function names Codex shows the model for the tools file mode enables: its command tool and
 * `view_image`. Codex 0.154 always uses unified exec (`exec_command` + `write_stdin`;
 * `features.unified_exec=false` has no effect there); older versions name the shell tool `shell`
 * or `shell_command` depending on the model family. The model gateway admits them for file-mode
 * Runs only. */
export const CODEX_FILE_FUNCTIONS: readonly string[] = Object.freeze([
  "exec_command",
  "write_stdin",
  "shell",
  "shell_command",
  "view_image"
]);

/** Per-Run Codex `-c` overrides and capability environment variables. The tool gateway is
 * registered as MCP server `toolServer`, so the model sees its tools as `mcp__<toolServer>`. */
export function codexManagedConfig(config: CodexManagedConfig): HarnessLaunch {
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
    return parsed.href;
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
      new Set(config.enabledTools).size !== config.enabledTools.length ||
      (config.fileTools !== undefined && typeof config.fileTools !== "boolean")
    )
      throw Error();
    const files = config.fileTools === true;
    const provider = `model_providers.${PROVIDER}`;
    const server = `mcp_servers.${config.toolServer}`;
    const settings: Record<string, unknown> = {
      model: config.modelAlias,
      model_provider: PROVIDER,
      // Business operations go through the authorized MCP only. Web search is the provider's
      // own tool (`{type:"web_search", external_web_access:true}`; "cached" would send false
      // and use the provider's index only): the model gateway keeps, narrows or removes it per
      // Run, so it is always offered here. Gateway validation stays authoritative.
      web_search: "live",
      // File mode (conversation files in /workspace): commands and image viewing inside the
      // sandbox. The Driver then starts the thread without a Codex sandbox or approvals: the
      // container is the sandbox. Commands never inherit the Run's capability variables.
      "features.shell_tool": files,
      "features.view_image": files,
      ...(files ? { "shell_environment_policy.exclude": ["SANDLANE_*"] } : {}),
      // Goal tools (get/create/update_goal) keep state in the CLI's own session, which the
      // gateway does not admit; a Run is one task anyway.
      "features.goals": false,
      "features.multi_agent": false,
      "features.apps": false,
      "features.plugins": false,
      "features.enable_request_compression": false,
      [`${provider}.name`]: "SandLane Model Gateway",
      [`${provider}.base_url`]: url(config.modelBaseUrl),
      [`${provider}.wire_api`]: "responses",
      [`${provider}.env_key`]: MODEL_CAPABILITY_ENV,
      [`${provider}.requires_openai_auth`]: false,
      [`${provider}.supports_websockets`]: false,
      [`${provider}.request_max_retries`]: 0,
      [`${provider}.stream_max_retries`]: 0,
      [`${server}.url`]: url(config.mcpUrl),
      [`${server}.bearer_token_env_var`]: TOOL_CAPABILITY_ENV,
      [`${server}.enabled_tools`]: [...config.enabledTools],
      [`${server}.tool_timeout_sec`]: TOOL_TIMEOUT_SEC,
      // Codex asks for approval before MCP tools it considers writes and, with approval policy
      // "never", rejects them outright. Authorization belongs to the platform behind the tool
      // gateway (the Run owner's own permissions); operator-configured sensitive operations are
      // confirmed by the user through the gateway instead (approval bridge).
      [`${server}.default_tools_approval_mode`]: "approve",
      [`${server}.required`]: true
    };
    return {
      args: Object.entries(settings).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`
      ]),
      env: {
        [MODEL_CAPABILITY_ENV]: config.modelCapability,
        [TOOL_CAPABILITY_ENV]: config.toolCapability
      }
    };
  } catch {
    throw new Error("Invalid managed Codex configuration");
  }
}

/** Function names Codex shows the model: tool gateway tools (the client action included) as
 * `mcp__<server>.<tool>`, dots in a tool name becoming underscores. The model gateway admits
 * exactly these. */
export function codexModelFunctions(toolServer: string, tools: readonly string[]): string[] {
  return tools.map(tool => `mcp__${toolServer}.${tool.replaceAll(".", "_")}`);
}

const CODEX_HOME = "/home/runner/.codex";

/** The Codex Driver's launch description for the sandbox: `codex [-c ...] app-server`. */
export const codexLauncher: HarnessLauncher = Object.freeze({
  command: "/usr/local/bin/codex",
  args: Object.freeze(["app-server"]),
  env: Object.freeze({ CODEX_HOME }),
  stateDirs: Object.freeze([CODEX_HOME]),
  configure: (config: HarnessLaunchConfig): HarnessLaunch => {
    const managed = codexManagedConfig(config);
    return { args: [...managed.args, "app-server"], env: managed.env };
  }
});
