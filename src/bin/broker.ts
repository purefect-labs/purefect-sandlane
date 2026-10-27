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
import { readSecret } from "../common/env.js";
import { claudeCodeLauncher } from "../harness/claude-code/claude-code-launcher.js";
import { codexLauncher } from "../harness/codex/codex-managed-config.js";
import type { HarnessLauncher } from "../spi/harness.js";
import { brokerSettings } from "../sandbox/docker/config.js";
import { DockerEngine } from "../sandbox/docker/docker-engine.js";
import { SandboxBroker } from "../sandbox/docker/lifecycle.js";
import { createBrokerServer, listenUnix } from "../sandbox/docker/server.js";
import { acquireStateLock } from "../sandbox/docker/state-lock.js";

const config = brokerSettings(process.env);
if (process.platform !== "linux") throw new Error("Broker requires a dedicated Linux execution node");
process.umask(0o077);
// Launch descriptions of the Drivers this build ships; SANDLANE_BROKER_RUN_IMAGES selects which
// of them this node runs and in which image. The Broker does not know the CLIs themselves.
const LAUNCHERS: Readonly<Record<string, HarnessLauncher>> = { codex: codexLauncher, "claude-code": claudeCodeLauncher };
const { images, memoryMiB, ...settings } = config;
const harnesses = Object.fromEntries(Object.entries(images).map(([id, image]) => {
  if (!Object.hasOwn(LAUNCHERS, id)) throw new Error(`Unknown harness ${id} in SANDLANE_BROKER_RUN_IMAGES`);
  return [id, { image, launcher: LAUNCHERS[id]!, ...(Object.hasOwn(memoryMiB, id) ? { memoryMiB: memoryMiB[id]! } : {}) }];
}));
const broker = new SandboxBroker(new DockerEngine(config.dockerSocket, config.apiVersion), {
  ...settings,
  labelPrefix: config.labelPrefix ?? "cn.purefect.sandlane",
  harnesses
});
const server = createBrokerServer(broker, await readSecret(process.env, "SANDLANE_BROKER_SERVICE_TOKEN"));
const releaseLock = await acquireStateLock(config.stateDir);
// Bind before reconciliation: a second instance must not tear down a live Broker's allocations.
try { await listenUnix(server, config.socketPath, config.socketGroupId); await broker.init(); }
catch (error) { server.close(); await releaseLock(); throw error; }
let busy = false;
const watchdog = setInterval(() => {
  if (busy) return;
  busy = true;
  broker.reconcile().catch(() => { console.error("Broker reconciliation failed; manual inspection required"); })
    .finally(() => { busy = false; });
}, 1_000);
let closing = false;
async function stop(): Promise<void> {
  if (closing) return; closing = true;
  clearInterval(watchdog); server.close();
  try { await broker.shutdown(); await releaseLock(); }
  catch { process.exitCode = 1; console.error("Broker cleanup incomplete; state lock retained for reconciliation"); }
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
