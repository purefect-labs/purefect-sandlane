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
import { SITE, TENANT_CODE } from "./contract.js";
import {
  ToolCallFailed,
  ToolGatewayError,
  type ConfirmPrompt,
  type ToolDeployment,
  type ToolDescriptor,
  type ToolInput,
  type ToolProvider
} from "../../spi/tool-provider.js";

/** A managed purefect-client instance: one per call, bound to the Run owner's short-lived token. */
export interface ManagedPurefectClient {
  request(api: string, params: unknown): Promise<unknown>;
}
/** Trusted deployment supplies the managed PurefectClient constructor, never Harness input.
 * The client must reject redirects, enforce TLS, bound responses and never retry/refresh tokens. */
export interface ManagedPurefectClientFactory {
  (
    config: Readonly<{
      mode: "managed";
      gateway: string;
      tenantCode: string;
      loginSite: string;
      accessToken: string;
      expiresAt: number;
      timeout: number;
    }>
  ): ManagedPurefectClient;
}

/** One published tool. `call` runs a validated call; `client(site)` creates a managed client for
 * the Run owner (on the lease's site unless another site is named). */
export interface PurefectTool extends ToolDescriptor {
  call(
    args: Readonly<Record<string, unknown>>,
    client: (site?: string) => ManagedPurefectClient,
    signal: AbortSignal
  ): Promise<unknown>;
  /** Audit fields (identifiers only). */
  summarize?(args: Readonly<Record<string, unknown>>): Readonly<Record<string, string>>;
  /** Approval bridge: what to show the user when this call matches the Run's confirm patterns. */
  confirmation?(
    args: Readonly<Record<string, unknown>>,
    patterns: readonly string[]
  ): ConfirmPrompt | undefined;
}

const reject = (): never => {
  throw new ToolGatewayError("PUREFECT_TOOL_REJECTED");
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** purefect-client managed errors (codes only) as failures the model may see. `definite`: the
 * platform answered or the client refused before sending; otherwise the outcome is unknown. */
const CLIENT_FAILURES: Readonly<Record<string, readonly [string, boolean]>> = Object.freeze({
  MANAGED_API_FAILED: ["PLATFORM_API_FAILED", true],
  MANAGED_HTTP_REJECTED: ["PLATFORM_HTTP_REJECTED", true],
  MANAGED_API_REJECTED: ["API_CODE_REJECTED", true],
  MANAGED_REQUEST_LIMIT: ["REQUEST_TOO_LARGE", true],
  MANAGED_RESPONSE_LIMIT: ["RESPONSE_TOO_LARGE", false],
  MANAGED_RESPONSE_INVALID: ["RESPONSE_INVALID", false],
  MANAGED_TIMEOUT: ["PLATFORM_TIMEOUT", false],
  MANAGED_TRANSPORT_FAILED: ["PLATFORM_UNREACHABLE", false]
});

export function classifyClientError(error: unknown): unknown {
  if (error instanceof ToolGatewayError) return error;
  if (error instanceof Error && error.name === "InjectedTokenExpiredError")
    return new ToolCallFailed("TOKEN_EXPIRED", true);
  const known = error instanceof Error ? CLIENT_FAILURES[error.message] : undefined;
  // purefect-client attaches the platform's fault code (identifier only) to MANAGED_API_FAILED.
  const fault = (error as { platformFault?: unknown } | undefined)?.platformFault;
  return known
    ? new ToolCallFailed(known[0], known[1], typeof fault === "string" ? fault : undefined)
    : error;
}

/** Integration adapter for Purefect tools, not an authorization service: platform calls use the
 * Run owner's short-lived token, so the platform applies that user's own permissions (it also
 * refuses the AI's own control APIs to such tokens). */
export class ManagedPurefectAdapter implements ToolProvider {
  private readonly gateway: string;
  private readonly catalog: ReadonlyMap<string, Readonly<PurefectTool>>;
  readonly tools: readonly Readonly<PurefectTool>[];
  private readonly deployment: Readonly<Omit<ToolDeployment, "toolVersion" | "serverVersion">>;
  constructor(
    gateway: string,
    catalog: readonly PurefectTool[],
    private readonly createClient: ManagedPurefectClientFactory,
    deployment: Omit<ToolDeployment, "toolVersion" | "serverVersion">
  ) {
    if (
      !deployment ||
      deployment.serverId !== "purefect" ||
      !Number.isSafeInteger(deployment.targetVersion) ||
      deployment.targetVersion < 1 ||
      typeof deployment.targetRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(deployment.targetRef)
    )
      reject();
    this.deployment = Object.freeze({ ...deployment });
    const url = new URL(gateway);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      reject();
    this.gateway = url.origin;
    const entries = new Map<string, Readonly<PurefectTool>>();
    for (const tool of catalog) {
      if (
        typeof tool.readOnly !== "boolean" ||
        typeof tool.validateParams !== "function" ||
        typeof tool.call !== "function" ||
        entries.has(tool.alias) ||
        !Number.isSafeInteger(tool.version) ||
        tool.version < 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tool.alias)
      )
        reject();
      entries.set(tool.alias, Object.freeze({ ...tool }));
    }
    this.catalog = entries;
    this.tools = Object.freeze([...entries.values()]);
  }

  validate(input: ToolInput, deployment: Readonly<ToolDeployment>): void {
    const tool = this.catalog.get(input.toolAlias);
    if (
      !tool ||
      !deployment ||
      deployment.serverId !== this.deployment.serverId ||
      !Number.isSafeInteger(deployment.serverVersion) ||
      deployment.serverVersion < 1 ||
      deployment.targetRef !== this.deployment.targetRef ||
      deployment.targetVersion !== this.deployment.targetVersion ||
      deployment.toolVersion !== tool.version
    )
      reject();
    tool!.validateParams(input.arguments);
  }

  summarize(input: ToolInput): Readonly<Record<string, string>> {
    return this.catalog.get(input.toolAlias)?.summarize?.(input.arguments) ?? {};
  }

  confirmation(input: ToolInput, operations: readonly string[]): ConfirmPrompt | undefined {
    return this.catalog.get(input.toolAlias)?.confirmation?.(input.arguments, operations);
  }

  async invoke(
    input: ToolInput,
    identity: Parameters<ToolProvider["invoke"]>[1],
    accessToken: string,
    signal: AbortSignal,
    expiresAt: number
  ): Promise<unknown> {
    signal.throwIfAborted();
    this.validate(input, identity);
    // Routing comes from the lease identity this plugin's contract parsed (see contract.ts).
    const { [TENANT_CODE]: tenantCode, [SITE]: site } = identity.attributes ?? {};
    if (
      !tenantCode ||
      !NAME.test(tenantCode) ||
      !site ||
      !NAME.test(site) ||
      !/^[1-9][0-9]{0,18}$/.test(identity.actorTenantAccessId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      typeof accessToken !== "string" ||
      !/^[\x21-\x7e]{32,8192}$/.test(accessToken)
    )
      reject();
    const client = (target?: string) => {
      if (target !== undefined && !NAME.test(target)) reject();
      const lifetime = Math.min(expiresAt, Date.now() + 30_000);
      return this.createClient(
        Object.freeze({
          mode: "managed",
          gateway: this.gateway,
          tenantCode: tenantCode!,
          loginSite: target ?? site!,
          accessToken,
          expiresAt: lifetime,
          timeout: Math.max(1, lifetime - Date.now())
        })
      );
    };
    // The managed client has no AbortSignal API. It bounds IO to <=30s and never retries; the
    // gateway records UNKNOWN on cancellation and suppresses any late result.
    let result: unknown;
    try {
      result = await this.catalog.get(input.toolAlias)!.call(input.arguments, client, signal);
    } catch (error) {
      throw classifyClientError(error);
    }
    signal.throwIfAborted();
    return result;
  }
}
