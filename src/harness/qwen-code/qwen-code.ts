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
import type {
  HarnessCapabilities,
  HarnessLaunch,
  HarnessLaunchConfig,
  HarnessLauncher,
  HarnessTransport
} from "../../spi/harness.js";
import type { ReasoningEffort } from "../../spi/control-plane.js";
import {
  SingleShotDriver,
  type SingleShotEmitter,
  type SingleShotProtocol,
  type SingleShotTerminal
} from "../single-shot/driver.js";
import { singleShotManagedConfig } from "../single-shot/managed-config.js";
export { qwenCodeModelFunctions } from "../../common/builtin-harness.js";

export const QWEN_CODE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  schemaVersion: 1,
  streamingText: true,
  interactiveInput: false,
  approvalBridge: false,
  nativeResume: false,
  modelWire: "responses",
  sessionPolicy: "ephemeral"
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

function summary(block: Record<string, unknown>, status: "inProgress" | "completed") {
  const id = typeof block.id === "string" && NAME.test(block.id) ? block.id : undefined;
  const name = typeof block.name === "string" && NAME.test(block.name) ? block.name : undefined;
  if (!id || !name) return;
  return { type: "mcpToolCall", id, tool: name, status };
}

/** Qwen Code 0.26 stream-json protocol. Partial text is authoritative; completed assistant
 * messages are used only when partial messages were not emitted. */
class QwenCodeProtocol implements SingleShotProtocol {
  readonly capabilities = QWEN_CODE_CAPABILITIES;
  private partialText = false;
  private readonly tools = new Set<string>();

  exited(code: number): SingleShotTerminal {
    return {
      type: "run.failed",
      data: { code: code === 0 ? "HARNESS_TERMINAL_MISSING" : "HARNESS_PROCESS_FAILED" }
    };
  }

  consume(value: Record<string, unknown>, emit: SingleShotEmitter): SingleShotTerminal | undefined {
    if (value.type === "stream_event") {
      const event = value.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const frame = event as Record<string, unknown>;
      if (frame.type === "content_block_delta") {
        const delta = frame.delta;
        if (delta && typeof delta === "object" && !Array.isArray(delta)) {
          const d = delta as Record<string, unknown>;
          if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
            this.partialText = true;
            emit.event("message.delta", { delta: d.text });
          }
        }
      }
      if (frame.type === "content_block_start") {
        const block = frame.content_block;
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use") {
            const item = summary(b, "inProgress");
            if (item) {
              this.tools.add(String(b.id));
              emit.event("item.started", { item });
            }
          }
        }
      }
      return;
    }
    if (value.type === "assistant") {
      const message = value.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const block = raw as Record<string, unknown>;
        if (
          !this.partialText &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text
        )
          emit.event("message.delta", { delta: block.text });
        if (block.type === "tool_use") {
          const item = summary(block, "inProgress");
          if (item && !this.tools.has(String(block.id))) {
            this.tools.add(String(block.id));
            emit.event("item.started", { item });
          }
        }
      }
      return;
    }
    if (value.type === "user") {
      const message = value.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const block = raw as Record<string, unknown>;
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const id = block.tool_use_id;
        if (this.tools.delete(id))
          emit.event("item.completed", {
            item: {
              type: "mcpToolCall",
              id,
              status: block.is_error === true ? "failed" : "completed"
            }
          });
      }
      return;
    }
    if (value.type === "result")
      return value.subtype === "success" && value.is_error === false
        ? { type: "run.completed" }
        : { type: "run.failed", data: { code: "QWEN_CODE_RESULT_ERROR" } };
    if (!["system", "control_request", "control_response"].includes(String(value.type)))
      throw new Error("Unknown Qwen Code frame");
  }
}

export interface QwenCodeDriverOptions {
  readonly transport: HarnessTransport;
  readonly reasoningEffort?: ReasoningEffort;
  readonly onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
}

export class QwenCodeDriver extends SingleShotDriver {
  constructor(options: QwenCodeDriverOptions) {
    super({ ...options, protocol: () => new QwenCodeProtocol() });
  }
}

const QWEN_HOME = "/home/runner/.qwen";

export const qwenCodeLauncher: HarnessLauncher = Object.freeze({
  command: "/usr/local/bin/sandlane-harness-shim",
  args: Object.freeze([]),
  env: Object.freeze({ HOME: "/home/runner", QWEN_HOME }),
  stateDirs: Object.freeze([QWEN_HOME]),
  configure: (config: HarnessLaunchConfig): HarnessLaunch =>
    singleShotManagedConfig("qwen-code", config)
});
