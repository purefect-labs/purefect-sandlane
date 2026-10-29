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
import type { ServerOptions } from "node:https";
import { RunCredentialRegistry } from "../core/credentials.js";
import { ModelGateway } from "../gateway/model/gateway.js";
import { defaultUpstreams, LocalModelAuthority } from "../gateway/model/local-authority.js";
import { createModelServer } from "../gateway/model/model-server.js";
import { ToolGateway, type ToolAudit } from "../gateway/tool/gateway.js";
import { LocalToolAuthority } from "../gateway/tool/local-authority.js";
import { createToolMcpServer } from "../gateway/tool/mcp-server.js";
import {
  BUILTIN_HARNESS_IDS,
  builtinFileFunctionInventory,
  builtinFunctionInventory,
  builtinWebFunctionInventory,
  isBuiltinHarness,
  type BuiltinHarnessId
} from "../common/builtin-harness.js";
import { createBuiltinDriver } from "../harness/builtin-runtime.js";
import {
  BrokerSandboxLauncher,
  type BrokerDriverFactory
} from "../sandbox/docker/broker-sandbox.js";
import { BrokerHarnessTransport } from "../sandbox/docker/broker-transport.js";
import { BrokerClient } from "../sandbox/docker/client.js";
import type { ToolProvider } from "../spi/tool-provider.js";
import type { ModelUpstreamFactory } from "../spi/model-upstream.js";
import type { ReasoningEffort } from "../spi/control-plane.js";
import { createRuntime, type RuntimeHandle, type RuntimeOptions } from "./runtime.js";

/** Bundled validated clients for composing trusted provider-specific routing/auth policies. */
export { defaultUpstreams as createDefaultModelUpstreams } from "../gateway/model/local-authority.js";

export interface ManagedGatewayEndpoint {
  readonly bind: string;
  readonly port: number;
  readonly hostname: string;
  readonly tls: Pick<ServerOptions, "key" | "cert">;
}

/** Experimental 0.x composition. Business adapters are borrowed; only resources explicitly
 * listed in resources transfer ownership, on invocation (including startup failure).
 * No environment, process signal handlers, application plugins or personal CLI state are loaded. */
export interface ManagedRuntimeOptions extends Omit<
  RuntimeOptions,
  "sandbox" | "credentials" | "lane"
> {
  readonly lane: Omit<RuntimeOptions["lane"], "admit" | "toolServer" | "enabledTools">;
  readonly broker: { readonly socket: string; readonly token: string; readonly nodeId: string };
  readonly tools: {
    readonly provider: ToolProvider;
    readonly serverId: string;
    readonly targetRef: string;
    readonly targetVersion: number;
    readonly enabled: readonly string[];
    readonly audit?: ToolAudit;
  };
  readonly harnesses?: readonly BuiltinHarnessId[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
  readonly gateways: {
    readonly model: ManagedGatewayEndpoint;
    readonly tool: ManagedGatewayEndpoint;
  };
  readonly model?: {
    /** Trusted custom upstream factory; replaces bundled transport/auth handling.
     * Never derive executable adapters from a Run, prompt, or untrusted configuration. */
    readonly upstreams?: ModelUpstreamFactory;
    readonly functions?: Readonly<Record<string, readonly string[]>>;
    readonly fileFunctions?: Readonly<Record<string, readonly string[]>>;
    readonly maxOutputTokens?: number;
    readonly timeoutMs?: number;
    readonly messagesAuth?: "x-api-key" | "bearer" | "both";
    readonly warmup?: Parameters<typeof defaultUpstreams>[1];
    readonly timing?: Parameters<typeof createModelServer>[4];
  };
  /** Optional metrics wrapper, e.g. a status recorder. It must preserve results and errors. */
  readonly track?: <T>(gateway: "model" | "tool", work: () => Promise<T>) => Promise<T>;
}

/** Builds the bundled Docker, Harness and TLS gateway implementations behind one small API.
 * Use createRuntime for other sandbox implementations. A healthy managed Broker is required. */
export async function createManagedRuntime(options: ManagedRuntimeOptions): Promise<RuntimeHandle> {
  let transferred = false;
  try {
    if (
      !Number.isSafeInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 16
    )
      throw new Error("INVALID_RUNTIME_CONCURRENCY");
    const ids = options.harnesses ?? BUILTIN_HARNESS_IDS;
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !isBuiltinHarness(id)))
      throw new Error("INVALID_MANAGED_HARNESSES");
    const { provider, serverId, targetRef, targetVersion, enabled } = options.tools;
    const catalog = provider.tools.map(tool => tool.alias);
    const special = [
      ...(options.controlPlane.clientActions ? [options.controlPlane.clientActions.name] : []),
      ...(options.controlPlane.controlTools ?? []).map(tool => tool.name)
    ];
    if (
      new Set([...catalog, ...special]).size !== catalog.length + special.length ||
      new Set(enabled).size !== enabled.length ||
      !enabled.some(name => catalog.includes(name)) ||
      enabled.some(name => ![...catalog, ...special].includes(name))
    )
      throw new Error("INVALID_MANAGED_TOOLS");
    const broker = new BrokerClient(options.broker.socket, options.broker.token);
    const status = await broker.status();
    if (
      status.nodeId !== options.broker.nodeId ||
      status.ready !== true ||
      status.managedLaunch !== true
    )
      throw new Error("Broker must be ready with managed gateways");
    const registry = new RunCredentialRegistry();
    const functions = options.model?.functions ?? builtinFunctionInventory(serverId, enabled, ids);
    const authority = new LocalModelAuthority(
      registry,
      {
        functions,
        webFunctions: builtinWebFunctionInventory(ids),
        fileFunctions: options.model?.fileFunctions ?? builtinFileFunctionInventory(ids),
        maxOutputTokens: options.model?.maxOutputTokens ?? 32_000
      },
      options.model?.upstreams ??
        defaultUpstreams(options.model?.messagesAuth ?? "x-api-key", options.model?.warmup)
    );
    const limits = {
      maxActive: Math.min(options.concurrency * 4, 64),
      timeoutMs: options.model?.timeoutMs ?? 600_000
    };
    const model = new ModelGateway(authority, authority, authority.provider, {
      maxConcurrent: limits.maxActive,
      timeoutMs: limits.timeoutMs,
      receiptTimeoutMs: 5_000
    });
    const modelEndpoint = options.gateways.model;
    const track = options.track ?? (async (_gateway, work) => work());
    const modelServer = createModelServer(
      modelEndpoint.tls,
      modelEndpoint.hostname,
      {
        respond: (...args) => track("model", () => model.respond(...args)),
        messages: (...args) => track("model", () => model.messages(...args))
      },
      authority.lookup,
      options.model?.timing,
      limits
    );
    const toolAuthority = new LocalToolAuthority(
      registry,
      { serverId, targetRef, targetVersion },
      provider.tools
    );
    const tool = new ToolGateway(
      toolAuthority,
      toolAuthority,
      new Map([[serverId, toolAuthority.bind(provider)]]),
      { concurrent: Math.min(options.concurrency * 4, 32), timeoutMs: 30_000, receiptMs: 5_000 },
      options.tools.audit
    );
    const toolEndpoint = options.gateways.tool;
    const toolServer = createToolMcpServer(
      toolEndpoint.tls,
      toolEndpoint.hostname,
      { invoke: (...args) => track("tool", () => tool.invoke(...args)) },
      toolAuthority.lookup,
      provider.tools,
      "sandlane-tools"
    );
    const defaults = {
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.onTiming ? { onTiming: options.onTiming } : {})
    };
    const drivers: Record<string, BrokerDriverFactory> = {};
    for (const id of ids)
      drivers[id] = binding => {
        const transport = new BrokerHarnessTransport(broker, binding);
        return createBuiltinDriver(id, { ...defaults, transport });
      };
    const sandbox = new BrokerSandboxLauncher(broker, options.broker.nodeId, drivers);
    transferred = true;
    return await createRuntime({
      controlPlane: options.controlPlane,
      sandbox,
      credentials: registry,
      concurrency: options.concurrency,
      lane: {
        ...options.lane,
        toolServer: serverId,
        enabledTools: enabled,
        admit: credential => {
          authority.admit(credential);
          authority.warm(credential);
        }
      },
      ...(options.observeLane ? { observeLane: options.observeLane } : {}),
      endpoints: [
        { server: modelServer, bind: modelEndpoint.bind, port: modelEndpoint.port },
        { server: toolServer, bind: toolEndpoint.bind, port: toolEndpoint.port },
        ...(options.endpoints ?? [])
      ],
      ...(options.resources ? { resources: options.resources } : {}),
      ...(options.log ? { log: options.log } : {})
    });
  } catch (error) {
    if (transferred) throw error;
    const failures: unknown[] = [];
    for (const resource of [...(options.resources ?? [])].reverse()) {
      try {
        await resource.close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], "MANAGED_STARTUP_CLEANUP_FAILED");
    throw error;
  }
}
