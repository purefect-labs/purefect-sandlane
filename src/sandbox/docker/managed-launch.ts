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
import { isIPv4 } from "node:net";
import { BrokerError, exactKeys, object } from "./contracts.js";
import type { HarnessLauncher } from "../../spi/harness.js";

export interface ManagedGatewayPolicy {
  modelBaseUrl: string;
  mcpUrl: string;
}
export interface ManagedModelSelection {
  modelAlias: string;
  toolServer: string;
  enabledTools: readonly string[];
}
export interface RunAuthorization extends ManagedModelSelection {
  model: Readonly<{ value: string; expiresAt: number }>;
  tool: Readonly<{ value: string; expiresAt: number }>;
  /** File mode: the CLI also gets its file and command tools. Only for a session allocation
   * whose inputs were written before its CLI starts (the Broker enforces both). */
  fileTools?: true;
}

/** Requested model/tool subset, never a replacement for Gateway authorization. */
export function parseModelSelection(value: unknown): Readonly<ManagedModelSelection> {
  const v = object(value);
  exactKeys(v, ["modelAlias", "toolServer", "enabledTools"]);
  const name = (v: unknown): v is string =>
    typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
  if (
    !name(v.modelAlias) ||
    typeof v.toolServer !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.toolServer) ||
    !Array.isArray(v.enabledTools) ||
    v.enabledTools.length < 1 ||
    v.enabledTools.length > 64 ||
    !v.enabledTools.every(name) ||
    new Set(v.enabledTools).size !== v.enabledTools.length
  )
    throw new BrokerError("INVALID_MODEL_SELECTION", 400, "Invalid managed model/tool selection");
  return Object.freeze({
    modelAlias: v.modelAlias,
    toolServer: v.toolServer,
    enabledTools: Object.freeze([...v.enabledTools])
  });
}

/** Operator configuration; neither Run input nor model output can select URLs. */
export function parseGatewayPolicy(value: unknown): Readonly<ManagedGatewayPolicy> {
  try {
    const v = object(value);
    exactKeys(v, ["modelBaseUrl", "mcpUrl"]);
    const url = (raw: unknown) => {
      if (typeof raw !== "string" || raw.length > 2048 || !/^[\x21-\x7e]+$/.test(raw))
        throw Error();
      const parsed = new URL(raw);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !/^[a-z][a-z0-9.-]*[a-z0-9]$/.test(parsed.hostname) ||
        parsed.hostname.includes("..")
      )
        throw Error();
      return parsed.href;
    };
    return Object.freeze({ modelBaseUrl: url(v.modelBaseUrl), mcpUrl: url(v.mcpUrl) });
  } catch {
    throw new BrokerError("INVALID_GATEWAY_POLICY", 400, "Invalid managed Gateway policy");
  }
}

/** Private Host delivery only. Token shape cannot prove authority: Gateways must
 * independently validate each capability and restore the original Run identity.
 */
export function parseRunAuthorization(
  value: unknown,
  expiresAt: number,
  now: number
): Readonly<RunAuthorization> {
  try {
    const v = object(value);
    exactKeys(v, [
      "modelAlias",
      "toolServer",
      "enabledTools",
      "model",
      "tool",
      ...(v.fileTools !== undefined ? ["fileTools"] : [])
    ]);
    if (v.fileTools !== undefined && v.fileTools !== true) throw Error();
    const capability = (raw: unknown) => {
      const c = object(raw);
      exactKeys(c, ["value", "expiresAt"]);
      if (
        typeof c.value !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(c.value) ||
        !Number.isSafeInteger(c.expiresAt) ||
        c.expiresAt !== expiresAt ||
        expiresAt <= now
      )
        throw Error();
      return Object.freeze({ value: c.value, expiresAt });
    };
    const selection = parseModelSelection({
      modelAlias: v.modelAlias,
      toolServer: v.toolServer,
      enabledTools: v.enabledTools
    });
    const model = capability(v.model),
      tool = capability(v.tool);
    if (model.value === tool.value) throw Error();
    return Object.freeze({
      ...selection,
      model,
      tool,
      ...(v.fileTools === true ? { fileTools: true as const } : {})
    });
  } catch {
    throw new BrokerError("INVALID_RUN_AUTHORIZATION", 400, "Invalid scoped Run authorization");
  }
}

export function launchDigest(
  policy: ManagedGatewayPolicy,
  authorization: RunAuthorization
): string {
  // Only this high-entropy token-containing digest enters the Broker ledger.
  return createHash("sha256").update(JSON.stringify({ policy, authorization })).digest("hex");
}

/** `harness` is the Driver's launch description: the Broker applies its arguments and environment
 * without knowing the CLI's configuration format. */
export function managedLaunch(
  policy: ManagedGatewayPolicy,
  authorization: RunAuthorization,
  relayIp: string,
  harness: HarnessLauncher
) {
  if (!isIPv4(relayIp))
    throw new BrokerError("INVALID_RELAY_ADDRESS", 503, "Relay IPv4 address unavailable");
  const config = harness.configure({
    ...policy,
    modelAlias: authorization.modelAlias,
    toolServer: authorization.toolServer,
    enabledTools: authorization.enabledTools,
    modelCapability: authorization.model.value,
    toolCapability: authorization.tool.value,
    ...(authorization.fileTools ? { fileTools: true } : {})
  });
  return {
    fileTools: authorization.fileTools === true,
    args: config.args,
    env: [
      ...Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"
    ],
    // DNS names remain intact for TLS SNI/verification; Docker resolves them only
    // to the Relay endpoint in this allocation's own private network.
    extraHosts: [
      ...new Set([policy.modelBaseUrl, policy.mcpUrl].map(url => new URL(url).hostname))
    ].map(host => `${host}:${relayIp}`)
  };
}
