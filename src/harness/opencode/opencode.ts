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
import type { ReasoningEffort } from "../../spi/control-plane.js";
import type {
  HarnessCapabilities,
  HarnessLaunch,
  HarnessLaunchConfig,
  HarnessLauncher,
  HarnessTransport
} from "../../spi/harness.js";
import {
  SingleShotDriver,
  type SingleShotEmitter,
  type SingleShotProtocol,
  type SingleShotTerminal
} from "../single-shot/driver.js";
import { singleShotManagedConfig } from "../single-shot/managed-config.js";
export { openCodeModelFunctions } from "../../common/builtin-harness.js";

export const OPENCODE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  schemaVersion: 1,
  streamingText: false,
  interactiveInput: false,
  approvalBridge: false,
  nativeResume: false,
  modelWire: "responses",
  sessionPolicy: "ephemeral"
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

class OpenCodeProtocol implements SingleShotProtocol {
  readonly capabilities = OPENCODE_CAPABILITIES;
  private failed = false;

  exited(code: number): SingleShotTerminal {
    if (code !== 0) return { type: "run.failed", data: { code: "HARNESS_PROCESS_FAILED" } };
    return this.failed
      ? { type: "run.failed", data: { code: "OPENCODE_RESULT_ERROR" } }
      : { type: "run.completed" };
  }

  consume(value: Record<string, unknown>, emit: SingleShotEmitter): SingleShotTerminal | undefined {
    if (value.type === "error") {
      this.failed = true;
      return;
    }
    if (value.type === "text") {
      const part = value.part;
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string" && text) emit.event("message.delta", { delta: text });
      }
      return;
    }
    if (value.type === "tool_use") {
      const part = value.part;
      if (!part || typeof part !== "object" || Array.isArray(part)) return;
      const tool = part as Record<string, unknown>;
      const id = typeof tool.id === "string" && NAME.test(tool.id) ? tool.id : undefined;
      const name = typeof tool.tool === "string" && NAME.test(tool.tool) ? tool.tool : undefined;
      const state = tool.state;
      const status =
        state && typeof state === "object" && !Array.isArray(state)
          ? (state as Record<string, unknown>).status
          : undefined;
      if (!id || !name || !["completed", "error"].includes(String(status))) return;
      emit.event("item.started", {
        item: { type: "mcpToolCall", id, tool: name, status: "inProgress" }
      });
      emit.event("item.completed", {
        item: {
          type: "mcpToolCall",
          id,
          tool: name,
          status: status === "completed" ? "completed" : "failed"
        }
      });
      return;
    }
    if (["step_start", "step_finish", "reasoning"].includes(String(value.type))) return;
    throw new Error("Unknown OpenCode frame");
  }
}

export interface OpenCodeDriverOptions {
  readonly transport: HarnessTransport;
  readonly reasoningEffort?: ReasoningEffort;
  readonly onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
}

export class OpenCodeDriver extends SingleShotDriver {
  constructor(options: OpenCodeDriverOptions) {
    super({ ...options, protocol: () => new OpenCodeProtocol() });
  }
}

const OPENCODE_STATE = "/home/runner/.local/state/opencode";
const OPENCODE_DATA = "/home/runner/.local/share/opencode";
const OPENCODE_CONFIG = "/home/runner/.config/opencode";
const OPENCODE_CACHE = "/home/runner/.cache/opencode";

export const openCodeLauncher: HarnessLauncher = Object.freeze({
  command: "/usr/local/bin/sandlane-harness-shim",
  args: Object.freeze([]),
  env: Object.freeze({
    HOME: "/home/runner",
    XDG_STATE_HOME: "/home/runner/.local/state",
    XDG_DATA_HOME: "/home/runner/.local/share",
    XDG_CONFIG_HOME: "/home/runner/.config",
    XDG_CACHE_HOME: "/home/runner/.cache"
  }),
  stateDirs: Object.freeze([OPENCODE_STATE, OPENCODE_DATA, OPENCODE_CONFIG, OPENCODE_CACHE]),
  configure: (config: HarnessLaunchConfig): HarnessLaunch =>
    singleShotManagedConfig("opencode", config)
});
