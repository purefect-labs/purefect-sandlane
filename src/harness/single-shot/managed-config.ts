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
import type { HarnessLaunch, HarnessLaunchConfig } from "../../spi/harness.js";

export type SingleShotHarness = "qwen-code" | "opencode";

export function singleShotManagedConfig(
  harness: SingleShotHarness,
  config: HarnessLaunchConfig
): HarnessLaunch {
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
  const capability = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const url = (value: unknown): string => {
    if (typeof value !== "string" || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value))
      throw Error();
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw Error();
    return parsed.href;
  };
  try {
    if (
      !identifier(config.modelAlias) ||
      typeof config.toolServer !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.toolServer) ||
      !capability(config.modelCapability) ||
      !capability(config.toolCapability) ||
      config.modelCapability === config.toolCapability ||
      !Array.isArray(config.enabledTools) ||
      config.enabledTools.length < 1 ||
      config.enabledTools.length > 64 ||
      !config.enabledTools.every(identifier) ||
      new Set(config.enabledTools).size !== config.enabledTools.length ||
      config.fileTools === true
    )
      throw Error();
    return {
      args: [],
      env: {
        SANDLANE_SINGLE_SHOT_HARNESS: harness,
        SANDLANE_MODEL_BASE_URL: url(config.modelBaseUrl),
        SANDLANE_MODEL_ALIAS: config.modelAlias,
        SANDLANE_MODEL_CAPABILITY: config.modelCapability,
        SANDLANE_MCP_URL: url(config.mcpUrl),
        SANDLANE_MCP_SERVER: config.toolServer,
        SANDLANE_MCP_CAPABILITY: config.toolCapability,
        SANDLANE_MCP_TOOLS: JSON.stringify(config.enabledTools)
      }
    };
  } catch {
    throw new Error(`Invalid managed ${harness} configuration`);
  }
}
