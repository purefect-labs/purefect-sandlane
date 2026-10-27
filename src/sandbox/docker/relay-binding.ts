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
import { BrokerError, exactKeys, object } from "./contracts.js";
import type { Engine } from "./docker-engine.js";

/** Operator-pinned identity, persisted with each allocation for cleanup after upgrades. */
export interface RelayBinding {
  containerId: string;
  imageId: string;
  policyDigest: string;
}

export function parseRelayBinding(value: unknown): Readonly<RelayBinding> {
  const v = object(value);
  exactKeys(v, ["containerId", "imageId", "policyDigest"]);
  if (
    typeof v.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.containerId) ||
    typeof v.imageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(v.imageId) ||
    typeof v.policyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.policyDigest)
  ) {
    throw new BrokerError("INVALID_RELAY_BINDING", 400, "Invalid pinned Relay identity");
  }
  return Object.freeze({
    containerId: v.containerId,
    imageId: v.imageId,
    policyDigest: v.policyDigest
  });
}

/** Environment variable carrying the Relay's route table (see bin/relay). */
const RELAY_ROUTES_ENV = "SANDLANE_RELAY_ROUTES";

/** Check the actual container, not just an operator-supplied label or mutable name. The Relay
 * carries `<labelPrefix>.relay.node` and `<labelPrefix>.relay.policy` labels. */
export async function verifyRelay(
  engine: Engine,
  nodeId: string,
  labelPrefix: string,
  binding: RelayBinding,
  requireRunning = true
): Promise<void> {
  const info = object(await engine.request("GET", `/containers/${binding.containerId}/json`));
  const config = object(info.Config),
    host = object(info.HostConfig),
    state = object(info.State);
  const labels = object(config.Labels),
    sysctls = object(host.Sysctls);
  const env = config.Env;
  const allowed = new Set(["PATH", "NODE_VERSION", "YARN_VERSION", RELAY_ROUTES_ENV]);
  const values = new Map<string, string>();
  if (
    !Array.isArray(env) ||
    env.some(value => {
      if (typeof value !== "string") return true;
      const separator = value.indexOf("=");
      const key = value.slice(0, separator);
      if (separator < 1 || !allowed.has(key) || values.has(key)) return true;
      values.set(key, value.slice(separator + 1));
      return false;
    })
  )
    throw new BrokerError("RELAY_POLICY_MISMATCH", 503, "Relay environment rejected");
  const routes = values.get(RELAY_ROUTES_ENV) ?? "";
  if (
    info.Id !== binding.containerId ||
    info.Image !== binding.imageId ||
    (requireRunning && state.Running !== true) ||
    labels[`${labelPrefix}.relay.node`] !== nodeId ||
    labels[`${labelPrefix}.relay.policy`] !== binding.policyDigest ||
    !routes ||
    Buffer.byteLength(routes) > 4096 ||
    createHash("sha256").update(routes).digest("hex") !== binding.policyDigest ||
    config.User !== "1000:1000" ||
    JSON.stringify(config.Entrypoint) !== JSON.stringify(["/usr/local/bin/node"]) ||
    JSON.stringify(config.Cmd) !== JSON.stringify(["/app/bin/relay.js"]) ||
    host.Privileged !== false ||
    host.ReadonlyRootfs !== true ||
    !Array.isArray(host.CapDrop) ||
    !host.CapDrop.includes("ALL") ||
    (Array.isArray(host.CapAdd) && host.CapAdd.length !== 0) ||
    !Array.isArray(host.SecurityOpt) ||
    !host.SecurityOpt.includes("no-new-privileges:true") ||
    sysctls["net.ipv4.ip_forward"] !== "0" ||
    sysctls["net.ipv6.conf.all.forwarding"] !== "0" ||
    !Array.isArray(info.Mounts) ||
    info.Mounts.length !== 0 ||
    (host.Devices != null && (!Array.isArray(host.Devices) || host.Devices.length !== 0)) ||
    (host.DeviceRequests != null &&
      (!Array.isArray(host.DeviceRequests) || host.DeviceRequests.length !== 0)) ||
    Object.keys(object(host.PortBindings ?? {})).length !== 0 ||
    host.PublishAllPorts === true ||
    typeof host.NetworkMode !== "string" ||
    /^(host|container:)/.test(host.NetworkMode) ||
    host.PidMode !== "" ||
    host.IpcMode !== "private" ||
    typeof host.Memory !== "number" ||
    host.Memory <= 0 ||
    host.Memory > 256 * 1024 * 1024 ||
    typeof host.PidsLimit !== "number" ||
    host.PidsLimit < 1 ||
    host.PidsLimit > 128
  ) {
    throw new BrokerError("RELAY_POLICY_MISMATCH", 503, "Relay identity or confinement rejected");
  }
}
