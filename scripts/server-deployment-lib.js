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
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, open, readFile, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

export const COMMANDS = new Set(["init", "up", "status", "logs", "doctor"]);
export const DEFAULT_PROJECT = "purefect-ai-runtime";

export function parseEnvironment(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values.set(key, line.slice(separator + 1).trim());
  }
  return values;
}

function port(value, fallback, label = "Gateway port") {
  const selected = value || fallback;
  if (!/^\d+$/.test(selected) || Number(selected) < 1 || Number(selected) > 65535)
    throw new Error(`${label} must be an integer between 1 and 65535`);
  return Number(selected);
}

export function relayEnvironment(runtime) {
  const workerIp = runtime.get("SANDLANE_WORKER_IP");
  if (!workerIp || !isIP(workerIp))
    throw new Error("SANDLANE_WORKER_IP must be a fixed IP address");
  const modelPort = port(runtime.get("SANDLANE_MODEL_GATEWAY_PORT"), "19443");
  const toolPort = port(runtime.get("SANDLANE_TOOL_MCP_PORT"), "19444");
  const routes = JSON.stringify(
    [modelPort, toolPort].map(gatewayPort => ({
      listenHost: "0.0.0.0",
      listenPort: gatewayPort,
      upstreamHost: workerIp,
      upstreamPort: gatewayPort
    }))
  );
  const digest = createHash("sha256").update(routes).digest("hex");
  return `SANDLANE_RELAY_ROUTES=${routes}\nSANDLANE_RELAY_POLICY_DIGEST=${digest}\n`;
}

export function statusEndpoint(runtime) {
  const value = runtime.get("SANDLANE_STATUS_PORT");
  if (!value) return undefined;
  return `http://127.0.0.1:${port(value, value, "Status port")}/status.json`;
}

export function composeArguments(deployment, { binding = true } = {}) {
  const args = ["compose", "-p", deployment.project, "--env-file", deployment.runtimeEnv];
  if (deployment.relayEnv) args.push("--env-file", deployment.relayEnv);
  if (binding && deployment.bindingEnv) args.push("--env-file", deployment.bindingEnv);
  for (const file of deployment.composeFiles) args.push("-f", file);
  return args;
}

export function resolveDeployment({
  root,
  configDir,
  project = DEFAULT_PROJECT,
  composeFiles = [],
  exists
}) {
  const selectedConfigDir = path.resolve(configDir);
  const selectedComposeFiles =
    composeFiles.length > 0
      ? composeFiles.map(file => path.resolve(file))
      : [
          path.join(root, "deploy/compose.runtime.yaml"),
          path.join(root, "deploy/compose.purefect.yaml")
        ];
  const localOverlay = path.join(selectedConfigDir, "compose.server.yaml");
  if (composeFiles.length === 0 && exists(localOverlay)) selectedComposeFiles.push(localOverlay);
  return {
    root,
    configDir: selectedConfigDir,
    project,
    runtimeEnv: path.join(selectedConfigDir, "runtime.env"),
    relayEnv: path.join(selectedConfigDir, "relay.env"),
    bindingEnv: path.join(selectedConfigDir, "binding.env"),
    composeFiles: selectedComposeFiles
  };
}

export function discoverConfigDir({ explicit, environment, exists }) {
  if (explicit) return explicit;
  if (environment.SANDLANE_SERVER_CONFIG_DIR) return environment.SANDLANE_SERVER_CONFIG_DIR;
  for (const candidate of ["/etc/sandlane", "/etc/purefect/sandlane"])
    if (exists(path.join(candidate, "runtime.env"))) return candidate;
  return "/etc/sandlane";
}

export async function assertReadable(files) {
  for (const file of files) {
    try {
      await access(file, constants.R_OK);
    } catch {
      throw new Error(`Required deployment file is missing or unreadable: ${file}`);
    }
  }
}

export async function privateWrite(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function bindingValue(file) {
  const values = parseEnvironment(await readFile(file, "utf8"));
  return values.get("SANDLANE_BROKER_RELAY_BINDING");
}
