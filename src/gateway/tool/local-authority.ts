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
import { randomBytes } from "node:crypto";
import {
  ToolGatewayError,
  type ManagedTool,
  type ToolAuthority,
  type ToolConfirmation,
  type ToolPermit,
  type ToolRuntime,
  type ToolSecrets
} from "./gateway.js";
import type { McpRunBinding } from "./mcp-server.js";
import type { RunCredentialLookup, RunCredentialView } from "../../spi/run-credentials.js";
import type { ToolDescriptor } from "../../spi/tool-provider.js";

export interface LocalToolDeployment {
  /** Server ID of the registered ToolProvider (key of the gateway's tool map). */
  readonly serverId: string;
  readonly targetRef: string;
  readonly targetVersion: number;
}

interface Call {
  readonly credential: RunCredentialView;
  readonly receipt: string;
  dispatched: boolean;
}

const MAX_CALLS = 1024;
// Descriptive reference only: the material is the Run owner's short-lived token delivered by
// claim/sync and held in runtime memory. No vault lookup happens.
const AGENT_TOKEN_REF = "${secret://vault::ai.run.agent_token}";

/** In-process tool authority. MCP calls use the Run owner's current agent token (renewed by every sync). Expired token or revoked Run: new calls are
 * refused and in-flight downstream calls are aborted. Audit relies on the target API's own logs. */
export class LocalToolAuthority implements ToolAuthority, ToolSecrets {
  readonly #calls = new Map<string, Call>();
  readonly #versions: ReadonlyMap<string, number>;
  readonly #deployment: LocalToolDeployment;

  constructor(
    private readonly registry: RunCredentialLookup,
    deployment: LocalToolDeployment,
    catalog: readonly Pick<ToolDescriptor, "alias" | "version">[]
  ) {
    if (
      !deployment ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(deployment.serverId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(deployment.targetRef) ||
      !Number.isSafeInteger(deployment.targetVersion) ||
      deployment.targetVersion < 1
    )
      throw new Error("Invalid tool deployment");
    this.#deployment = Object.freeze({ ...deployment });
    this.#versions = new Map(catalog.map(tool => [tool.alias, tool.version]));
  }

  /** McpRunLookup for the MCP server: binding expires with the current agent token. The Run's
   * client action is relayed through its own lane and ends with the Run. */
  readonly lookup = async (capability: string): Promise<McpRunBinding | null> => {
    const credential = this.registry.byToolCapability(capability);
    const token = credential?.agentToken();
    if (!credential || !token) return null;
    const enabledTools = credential.grant.enabledTools.filter(tool => this.#versions.has(tool));
    const action = credential.clientAction;
    // Control plane tools are answered by this Run's lane too and end with the Run (revocation
    // aborts calls in flight).
    const controlTools = (credential.controlTools ?? []).map(tool =>
      Object.freeze({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        expiresAt: credential.grant.expiresAt,
        call: (args: unknown, signal: AbortSignal, callId?: string) =>
          tool.call(args, AbortSignal.any([signal, credential.signal]), callId)
      })
    );
    if (!enabledTools.length && !action && !controlTools.length) return null;
    return Object.freeze({
      runtime: credential.grant.runtime,
      expiresAt: Math.min(token.expiresAt, credential.grant.expiresAt),
      enabledTools: Object.freeze(enabledTools),
      ...(controlTools.length ? { controlTools: Object.freeze(controlTools) } : {}),
      // A call may wait for the user's approval: the request gets the client action deadline.
      ...(credential.confirmation ? { confirms: true } : {}),
      ...(action
        ? {
            clientAction: Object.freeze({
              name: action.name,
              description: action.description,
              inputSchema: action.inputSchema,
              expiresAt: credential.grant.expiresAt,
              call: (args: unknown, signal: AbortSignal) =>
                action.call(args, AbortSignal.any([signal, credential.signal]))
            })
          }
        : {})
    });
  };

  /** The Run's approval bridge; the wait also ends with the Run. */
  confirmation(
    input: Parameters<NonNullable<ToolAuthority["confirmation"]>>[0]
  ): ToolConfirmation | undefined {
    const credential = this.#current(input.capability, input.runtime);
    const confirmation = credential.confirmation;
    if (!confirmation?.operations.length) return undefined;
    return Object.freeze({
      operations: confirmation.operations,
      confirm: (request: Parameters<ToolConfirmation["confirm"]>[0], signal: AbortSignal) =>
        confirmation
          .confirm(request, AbortSignal.any([signal, credential.signal]))
          .catch(() => "unavailable" as const)
    });
  }

  async reserve(input: Parameters<ToolAuthority["reserve"]>[0]): Promise<ToolPermit> {
    const credential = this.#current(input.capability, input.runtime);
    const token = credential.agentToken();
    const version = this.#versions.get(input.call.toolAlias);
    if (
      !token ||
      version === undefined ||
      !credential.grant.enabledTools.includes(input.call.toolAlias)
    )
      throw new ToolGatewayError("TOOL_ACCESS_DENIED");
    if (this.#calls.has(input.call.callId)) throw new ToolGatewayError("TOOL_CALL_CONFLICT");
    if (this.#calls.size >= MAX_CALLS) throw new ToolGatewayError("TOOL_BUSY");
    const receipt = randomBytes(32).toString("base64url");
    this.#calls.set(input.call.callId, { credential, receipt, dispatched: false });
    const grant = credential.grant;
    return {
      tenantId: grant.tenantId,
      userId: grant.userId,
      subjectUserId: grant.userId,
      runId: grant.runId,
      attributes: grant.attributes,
      // The agent token itself binds the membership; this is the lease's copy for consistency checks.
      actorTenantAccessId: grant.tenantAccessId,
      credentialOwnerTenantAccessId: grant.tenantAccessId,
      callId: input.call.callId,
      toolAlias: input.call.toolAlias,
      requestDigest: input.requestDigest,
      credentialRef: AGENT_TOKEN_REF,
      credentialRow: null,
      serverId: this.#deployment.serverId,
      serverVersion: 1,
      targetRef: this.#deployment.targetRef,
      targetVersion: this.#deployment.targetVersion,
      toolVersion: version,
      bindingVersion: 1,
      credentialVersion: 1,
      expiresAt: Math.min(token.expiresAt, grant.expiresAt),
      receipt
    };
  }

  async read(
    permit: ToolPermit,
    signal: AbortSignal,
    execution: Readonly<{ capability: string; runtime: ToolRuntime }>
  ): Promise<{ accessToken: string; expiresAt: number }> {
    signal.throwIfAborted();
    const credential = this.#current(execution.capability, execution.runtime);
    const call = this.#calls.get(permit.callId);
    if (!call || call.credential !== credential || call.receipt !== permit.receipt)
      throw new ToolGatewayError("TOOL_CREDENTIAL_UNAVAILABLE");
    const token = credential.agentToken();
    if (!token) throw new ToolGatewayError("TOOL_CREDENTIAL_UNAVAILABLE");
    return { accessToken: token.value, expiresAt: Math.min(token.expiresAt, permit.expiresAt) };
  }

  async dispatch(input: Parameters<ToolAuthority["dispatch"]>[0]): Promise<void> {
    const credential = this.#current(input.capability, input.runtime);
    const call = this.#calls.get(input.permit.callId);
    if (
      !call ||
      call.credential !== credential ||
      call.receipt !== input.permit.receipt ||
      call.dispatched ||
      !credential.toolUsable()
    )
      throw new ToolGatewayError("TOOL_CALL_CONFLICT");
    call.dispatched = true;
  }

  async finish(input: Parameters<ToolAuthority["finish"]>[0]): Promise<void> {
    const call = this.#calls.get(input.permit.callId);
    if (call && call.receipt === input.permit.receipt) this.#calls.delete(input.permit.callId);
  }

  /** Wrap the registered adapter so revocation or token expiry aborts in-flight downstream work. */
  bind(tool: ManagedTool): ManagedTool {
    return {
      validate: (input, deployment) => tool.validate(input, deployment),
      ...(tool.summarize
        ? {
            summarize: (input: Parameters<NonNullable<ManagedTool["summarize"]>>[0]) =>
              tool.summarize!(input)
          }
        : {}),
      ...(tool.confirmation
        ? {
            confirmation: (
              input: Parameters<NonNullable<ManagedTool["confirmation"]>>[0],
              operations: readonly string[]
            ) => tool.confirmation!(input, operations)
          }
        : {}),
      invoke: async (input, identity, accessToken, signal, expiresAt) => {
        const call = this.#calls.get(input.callId);
        if (!call || !call.dispatched) throw new ToolGatewayError("TOOL_CALL_REJECTED");
        const stop = AbortSignal.any([
          signal,
          call.credential.signal,
          AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))
        ]);
        stop.throwIfAborted();
        let abort = () => {};
        const aborted = new Promise<never>((_, reject) => {
          abort = () => reject(new ToolGatewayError("TOOL_ABORTED"));
          stop.addEventListener("abort", abort, { once: true });
        });
        try {
          return await Promise.race([
            tool.invoke(input, identity, accessToken, stop, expiresAt),
            aborted
          ]);
        } finally {
          stop.removeEventListener("abort", abort);
        }
      }
    };
  }

  #current(capability: string, runtime: ToolRuntime): RunCredentialView {
    const credential = this.registry.byToolCapability(capability);
    if (
      !credential ||
      !credential.toolUsable() ||
      runtime?.runtimeId !== credential.grant.runtime.runtimeId ||
      runtime?.allocationId !== credential.grant.runtime.allocationId
    )
      throw new ToolGatewayError("TOOL_IDENTITY_REQUIRED");
    return credential;
  }
}
