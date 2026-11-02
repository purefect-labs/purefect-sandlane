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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  DEFAULT_PROJECT,
  assertReadable,
  bindingValue,
  composeArguments,
  discoverConfigDir,
  parseEnvironment,
  privateWrite,
  relayEnvironment,
  resolveDeployment,
  statusEndpoint
} from "./server-deployment-lib.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const USAGE = `Usage: node scripts/sandlane-server.js <command> [options]

Commands:
  init      Validate configuration, start init/Relay, and refresh the immutable Relay binding
  up        Run init, then start Broker and Worker
  status    Show the Compose service state
  logs      Show recent Broker, Worker, and Relay logs; add --follow to stream
  doctor    Run read-only configuration, container, Relay binding, and status checks

Options:
  --config-dir <path>    Directory containing runtime.env, relay.env and binding.env
  --project <name>       Compose project (default: ${DEFAULT_PROJECT})
  --compose-file <path>  Override the bundled composition; repeat for multiple files
  --follow               Follow logs
  --help                  Show this help

The neutral default config directory is /etc/sandlane. Existing
/etc/purefect/sandlane installations are discovered for compatibility.`;

function argumentsOf(argv) {
  if (argv.includes("--help") || argv[0] === "help") return { help: true };
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error(USAGE);
  const options = { command, composeFiles: [], follow: false };
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--follow") {
      options.follow = true;
      continue;
    }
    if (!["--config-dir", "--project", "--compose-file"].includes(item))
      throw new Error(`Unknown option: ${item}\n\n${USAGE}`);
    const value = argv[(index += 1)];
    if (!value) throw new Error(`Missing value for ${item}`);
    if (item === "--config-dir") options.configDir = value;
    if (item === "--project") options.project = value;
    if (item === "--compose-file") options.composeFiles.push(value);
  }
  if (options.follow && command !== "logs") throw new Error("--follow is only valid with logs");
  return options;
}

function execute(command, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", chunk => (stdout += chunk));
      child.stderr.on("data", chunk => (stderr += chunk));
    }
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

async function compose(deployment, args, options = {}) {
  return execute("docker", [...composeArguments(deployment, options), ...args], options);
}

async function serviceId(deployment, service, binding = true) {
  const result = await compose(deployment, ["ps", "-q", service], { capture: true, binding });
  return result.stdout.trim();
}

async function inspectState(id) {
  const result = await execute("docker", ["inspect", "--format", "{{json .State}}", id], {
    capture: true
  });
  return JSON.parse(result.stdout);
}

async function waitForInit(deployment) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const id = await serviceId(deployment, "init", false);
    if (id) {
      const state = await inspectState(id);
      if (state.Status === "exited") {
        if (state.ExitCode !== 0)
          throw new Error(`init service exited with status ${state.ExitCode}`);
        return;
      }
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for init service");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function ensureRelayEnvironment(deployment) {
  if (existsSync(deployment.relayEnv)) return;
  const runtime = parseEnvironment(await readFile(deployment.runtimeEnv, "utf8"));
  await privateWrite(deployment.relayEnv, relayEnvironment(runtime));
  console.log(`Created ${deployment.relayEnv}`);
}

async function refreshBinding(deployment) {
  const relayId = await serviceId(deployment, "relay", false);
  if (!/^[a-f0-9]{64}$/.test(relayId)) throw new Error("Relay has no full immutable container ID");
  const result = await execute(process.execPath, ["scripts/relay-binding.js", "inspect", relayId], {
    capture: true
  });
  if (!result.stdout.startsWith("SANDLANE_BROKER_RELAY_BINDING="))
    throw new Error("Relay binding validation returned an invalid result");
  await privateWrite(deployment.bindingEnv, result.stdout.trimEnd() + "\n");
  console.log(`Validated Relay and refreshed ${deployment.bindingEnv}`);
}

async function initialize(deployment) {
  await assertReadable([deployment.runtimeEnv, ...deployment.composeFiles]);
  await ensureRelayEnvironment(deployment);
  await compose(deployment, ["config", "--quiet"], { binding: false });
  await compose(deployment, ["up", "-d", "--no-build", "--no-deps", "init", "relay"], {
    binding: false
  });
  await waitForInit(deployment);
  await refreshBinding(deployment);
}

async function containerCheck(deployment, service, expected) {
  const id = await serviceId(deployment, service);
  if (!id) throw new Error(`${service} container is missing`);
  const state = await inspectState(id);
  if (state.Status !== expected)
    throw new Error(`${service} is ${state.Status}, expected ${expected}`);
  if (state.Health && state.Health.Status !== "healthy")
    throw new Error(`${service} health is ${state.Health.Status}`);
  console.log(`PASS container.${service}: ${state.Health?.Status || state.Status}`);
  return id;
}

async function waitForStatus(endpoint, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastError;
  do {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (response.ok || response.status === 401) return response.status;
      lastError = new Error(`Status endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
  throw lastError;
}

async function doctor(deployment, { waitMs = 0 } = {}) {
  await assertReadable([
    deployment.runtimeEnv,
    deployment.relayEnv,
    deployment.bindingEnv,
    ...deployment.composeFiles
  ]);
  await compose(deployment, ["config", "--quiet"]);
  console.log("PASS compose.config");
  const relayId = await containerCheck(deployment, "relay", "running");
  await containerCheck(deployment, "broker", "running");
  await containerCheck(deployment, "execution", "running");
  const actual = await execute(process.execPath, ["scripts/relay-binding.js", "inspect", relayId], {
    capture: true
  });
  const configured = await bindingValue(deployment.bindingEnv);
  const observed = parseEnvironment(actual.stdout).get("SANDLANE_BROKER_RELAY_BINDING");
  if (!configured || configured !== observed) throw new Error("Configured Relay binding is stale");
  console.log("PASS relay.binding: immutable identity and confinement match");

  const runtime = parseEnvironment(await readFile(deployment.runtimeEnv, "utf8"));
  const endpoint = statusEndpoint(runtime);
  if (!endpoint) {
    console.log("SKIP worker.status: SANDLANE_STATUS_PORT is disabled");
    console.log("SandLane deployment checks passed");
    return;
  }
  const status = await waitForStatus(endpoint, waitMs);
  console.log(
    status === 401
      ? "PASS worker.status: endpoint reachable with authentication enabled"
      : `PASS worker.status: HTTP ${status} on ${new URL(endpoint).host}`
  );
  console.log("SandLane deployment checks passed");
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const configDir = discoverConfigDir({
    explicit: options.configDir,
    environment: process.env,
    exists: existsSync
  });
  const deployment = resolveDeployment({
    root: ROOT,
    configDir,
    project: options.project || process.env.SANDLANE_SERVER_PROJECT || DEFAULT_PROJECT,
    composeFiles: options.composeFiles,
    exists: existsSync
  });

  if (options.command === "init") return initialize(deployment);
  if (options.command === "up") {
    await initialize(deployment);
    await compose(deployment, ["up", "-d", "--no-build", "broker", "execution"]);
    return doctor(deployment, { waitMs: 30_000 });
  }
  if (options.command === "status") return compose(deployment, ["ps", "-a"]);
  if (options.command === "logs")
    return compose(deployment, [
      "logs",
      ...(options.follow ? ["--follow"] : ["--tail", "200"]),
      "broker",
      "execution",
      "relay"
    ]);
  if (options.command === "doctor") return doctor(deployment);
}

main().catch(error => {
  console.error(`sandlane-server: ${error.message}`);
  process.exitCode = 1;
});
