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
import { ClaudeCodeDriver } from "./claude-code/claude-code-driver.js";
import { claudeCodeLauncher } from "./claude-code/claude-code-launcher.js";
import { CodexRunAdapter } from "./codex/codex-adapter.js";
import { codexLauncher } from "./codex/codex-managed-config.js";
import { OpenCodeDriver, openCodeLauncher } from "./opencode/opencode.js";
import { QwenCodeDriver, qwenCodeLauncher } from "./qwen-code/qwen-code.js";
import { BUILTIN_HARNESS_IDS, type BuiltinHarnessId } from "../common/builtin-harness.js";
import type { ReasoningEffort } from "../spi/control-plane.js";
import type { HarnessDriver, HarnessLauncher, HarnessTransport } from "../spi/harness.js";

export const BUILTIN_HARNESS_LAUNCHERS: Readonly<Record<BuiltinHarnessId, HarnessLauncher>> =
  Object.freeze({
    codex: codexLauncher,
    "claude-code": claudeCodeLauncher,
    "qwen-code": qwenCodeLauncher,
    opencode: openCodeLauncher
  });

export interface BuiltinDriverOptions {
  readonly transport: HarnessTransport;
  readonly reasoningEffort?: ReasoningEffort;
  readonly onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
}

export function createBuiltinDriver(
  id: BuiltinHarnessId,
  options: BuiltinDriverOptions
): HarnessDriver {
  switch (id) {
    case "codex":
      return new CodexRunAdapter({ workspace: "/workspace", ...options });
    case "claude-code":
      return new ClaudeCodeDriver(options);
    case "qwen-code":
      return new QwenCodeDriver(options);
    case "opencode":
      return new OpenCodeDriver(options);
  }
}

// Compile-time exhaustiveness witness and convenient stable iteration order.
export const BUILTIN_HARNESSES: readonly BuiltinHarnessId[] = BUILTIN_HARNESS_IDS;
