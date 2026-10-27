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
import path from "node:path";
import { required, type Env } from "../../common/env.js";
import { identifier } from "./contracts.js";
import { parseRelayBinding } from "./relay-binding.js";
import { parseGatewayPolicy } from "./managed-launch.js";
import { OUTPUT_FILE_MAX_BYTES, OUTPUT_FILE_MAX_BYTES_CEILING, OUTPUT_MAX_FILES, OUTPUT_MAX_FILES_CEILING,
  OUTPUT_TOTAL_MAX_BYTES, OUTPUT_TOTAL_MAX_BYTES_CEILING, type OutputLimits } from "../../common/output-files.js";

const MIB = 1024 * 1024;

/** SANDLANE_BROKER_OUTPUT_MAX_FILES / _OUTPUT_FILE_MAX_MIB / _OUTPUT_TOTAL_MAX_MIB: what is read out of a
 * Run's outputs directory (defaults 10 files, 10 MiB each, 30 MiB together; the control plane takes at most
 * 10 files of 10 MiB, so those are also the ceilings). The total may not exceed the workspace. */
function outputLimits(env: Env, workspaceMiB: number): OutputLimits {
  const maxFiles = integer(env, "SANDLANE_BROKER_OUTPUT_MAX_FILES", OUTPUT_MAX_FILES, 1, OUTPUT_MAX_FILES_CEILING);
  const fileMiB = integer(env, "SANDLANE_BROKER_OUTPUT_FILE_MAX_MIB", OUTPUT_FILE_MAX_BYTES / MIB, 1, OUTPUT_FILE_MAX_BYTES_CEILING / MIB);
  const totalMiB = integer(env, "SANDLANE_BROKER_OUTPUT_TOTAL_MAX_MIB", OUTPUT_TOTAL_MAX_BYTES / MIB, 1,
    Math.min(workspaceMiB, OUTPUT_TOTAL_MAX_BYTES_CEILING / MIB));
  return { maxFiles, fileMaxBytes: fileMiB * MIB, totalMaxBytes: totalMiB * MIB };
}

function absolute(env: Env, key: string): string {
  const value = required(env, key);
  if (!path.isAbsolute(value) || value.includes("\0") || path.normalize(value) === "/") throw new Error(`${key} must be an absolute non-root path`);
  return path.normalize(value);
}
function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${key} must be ${min}..${max}`);
  return Number(value);
}

/** SANDLANE_BROKER_RUN_IMAGES: JSON object of Harness ID -> CLI image pinned by sha256 digest,
 * e.g. {"codex":"repo/cli@sha256:..."}. A Harness without an image is refused on this node. */
function runImages(env: Env): Record<string, string> {
  if (env.SANDLANE_BROKER_RUN_IMAGE !== undefined) throw new Error("SANDLANE_BROKER_RUN_IMAGE is replaced by SANDLANE_BROKER_RUN_IMAGES");
  const raw = required(env, "SANDLANE_BROKER_RUN_IMAGES");
  let value: unknown;
  try { value = raw.length <= 4096 ? JSON.parse(raw) : undefined; } catch { value = undefined; }
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  if (!entries.length || entries.length > 16 || !entries.every(([id, image]) => /^[a-z][a-z0-9-]{0,31}$/.test(id) &&
      typeof image === "string" && /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)))
    throw new Error("SANDLANE_BROKER_RUN_IMAGES must map harness IDs to sha256-pinned images");
  return Object.fromEntries(entries) as Record<string, string>;
}

/** SANDLANE_BROKER_RUN_MEMORY_MIB: optional JSON object of Harness ID -> container memory limit in MiB
 * (swap included, workspace tmpfs counted), e.g. {"codex":256}. Unlisted Harnesses keep 512 MiB. */
function runMemory(env: Env, images: Record<string, string>, workspaceMiB: number): Record<string, number> {
  const raw = env.SANDLANE_BROKER_RUN_MEMORY_MIB;
  if (raw === undefined) return {};
  let value: unknown;
  try { value = raw.length <= 1024 ? JSON.parse(raw) : undefined; } catch { value = undefined; }
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : undefined;
  if (!entries || !entries.every(([id, mib]) => Object.hasOwn(images, id) && Number.isSafeInteger(mib) &&
      Number(mib) >= 128 && Number(mib) <= 65536 && Number(mib) > workspaceMiB))
    throw new Error("SANDLANE_BROKER_RUN_MEMORY_MIB must map configured harness IDs to 128..65536 MiB above the workspace size");
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Broker settings from SANDLANE_BROKER_* variables. The Docker label prefix (SANDLANE_LABEL_PREFIX)
 * is optional here; the composition root supplies its default. */
export function brokerSettings(env: Env) {
  const images = runImages(env);
  const workspaceMiB = integer(env, "SANDLANE_BROKER_WORKSPACE_MIB", 96, 64, 4096);
  const memoryMiB = runMemory(env, images, workspaceMiB);
  const outputs = outputLimits(env, workspaceMiB);
  const maxConcurrent = integer(env, "SANDLANE_BROKER_MAX_CONCURRENT", 5, 1, 100);
  const perTenant = integer(env, "SANDLANE_BROKER_PER_TENANT", 2, 1, maxConcurrent);
  const socketGroupId = env.SANDLANE_BROKER_SOCKET_GROUP_ID === undefined ? undefined
    : integer(env, "SANDLANE_BROKER_SOCKET_GROUP_ID", 0, 1, 2147483647);
  const apiVersion = env.SANDLANE_BROKER_DOCKER_API_VERSION ?? "v1.45";
  const networkMode = env.SANDLANE_BROKER_NETWORK_MODE ?? "none";
  const labelPrefix = env.SANDLANE_LABEL_PREFIX;
  if (labelPrefix !== undefined && !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(labelPrefix)) throw new Error("Invalid SANDLANE_LABEL_PREFIX");
  const rawRelay = env.SANDLANE_BROKER_RELAY_BINDING;
  if (rawRelay && (rawRelay.length > 1024 || networkMode !== "isolated")) throw new Error("Invalid SANDLANE_BROKER_RELAY_BINDING");
  const relay = rawRelay ? parseRelayBinding(JSON.parse(rawRelay) as unknown) : undefined;
  const rawGateways = env.SANDLANE_BROKER_MANAGED_GATEWAYS;
  if (rawGateways && (rawGateways.length > 5000 || !relay)) throw new Error("Invalid SANDLANE_BROKER_MANAGED_GATEWAYS");
  const managedGateways = rawGateways ? parseGatewayPolicy(JSON.parse(rawGateways) as unknown) : undefined;
  if (!["none", "isolated"].includes(networkMode)) throw new Error("Invalid SANDLANE_BROKER_NETWORK_MODE");
  if (!/^v1\.\d+$/.test(apiVersion)) throw new Error("Invalid SANDLANE_BROKER_DOCKER_API_VERSION");
  return { nodeId: identifier(required(env, "SANDLANE_BROKER_NODE_ID")), images, memoryMiB, workspaceMiB, outputLimits: outputs, stateDir: absolute(env, "SANDLANE_BROKER_STATE_DIR"),
    socketPath: absolute(env, "SANDLANE_BROKER_SOCKET"), socketGroupId, dockerSocket: absolute(env, "SANDLANE_BROKER_DOCKER_SOCKET"),
    apiVersion, maxConcurrent, perTenant, ...(labelPrefix ? { labelPrefix } : {}),
    networkMode: networkMode as "none" | "isolated", ...(relay ? { relay } : {}), ...(managedGateways ? { managedGateways } : {}) };
}
