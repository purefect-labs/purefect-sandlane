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
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { readSecret, required } from "../common/env.js";
import { missingFunctions } from "../common/function-inventory.js";
import { MemoryAdmission, readMemAvailable } from "../core/admission.js";
import { RunCredentialRegistry } from "../core/credentials.js";
import { FrozenInputContext } from "../core/turn-input.js";
import type { LaneLog } from "../core/worker.js";
import { ModelGateway } from "../gateway/model/gateway.js";
import { defaultUpstreams, LocalModelAuthority } from "../gateway/model/local-authority.js";
import type { MessagesAuth } from "../gateway/model/messages-provider.js";
import { createModelServer } from "../gateway/model/model-server.js";
import { ToolGateway } from "../gateway/tool/gateway.js";
import { LocalToolAuthority } from "../gateway/tool/local-authority.js";
import { createToolMcpServer } from "../gateway/tool/mcp-server.js";
import {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeDriver
} from "../harness/claude-code/claude-code-driver.js";
import {
  CLAUDE_CODE_FILE_FUNCTIONS,
  CLAUDE_CODE_WEB_FUNCTIONS,
  claudeCodeModelFunctions
} from "../harness/claude-code/claude-code-launcher.js";
import { CODEX_CAPABILITIES, CodexRunAdapter } from "../harness/codex/codex-adapter.js";
import {
  CODEX_FILE_FUNCTIONS,
  codexModelFunctions
} from "../harness/codex/codex-managed-config.js";
import { businessInstructions } from "../plugins/purefect/business-instructions.js";
import { PurefectContext } from "../plugins/purefect/context.js";
import { PapiControlPlane } from "../plugins/purefect/control-plane.js";
import type { ManagedPurefectClientFactory } from "../plugins/purefect/purefect-adapter.js";
import {
  ApiDocs,
  apiDocsDirectory,
  installPurefectTools,
  PUREFECT_TOOL_NAMES,
  PUREFECT_TOOL_SERVER
} from "../plugins/purefect/purefect-catalog.js";
import {
  BrokerSandboxLauncher,
  type BrokerDriverFactory
} from "../sandbox/docker/broker-sandbox.js";
import { BrokerHarnessTransport } from "../sandbox/docker/broker-transport.js";
import { BrokerClient } from "../sandbox/docker/client.js";
import { createRuntime } from "../runtime/runtime.js";
import type { ContextProvider } from "../spi/context.js";
import type { ReasoningEffort } from "../spi/control-plane.js";
import type { StatusObserver } from "../spi/status.js";
import { StatusRecorder } from "../status/recorder.js";
import { createStatusServer, StatusPanel, statusPanelConfig } from "../status/server.js";

type Env = Record<string, string | undefined>;

async function pem(file: string): Promise<Buffer> {
  if (!isAbsolute(file)) throw Error();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 65_536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] ?? String(fallback);
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error(`${key} must be ${min}..${max}`);
  return Number(value);
}

function list(env: Env, key: string, fallback: readonly string[], pattern: RegExp): string[] {
  const raw = env[key];
  const values =
    raw === undefined
      ? [...fallback]
      : raw
          .split(",")
          .map(v => v.trim())
          .filter(Boolean);
  if (
    !values.length ||
    values.length > 64 ||
    new Set(values).size !== values.length ||
    !values.every(v => pattern.test(v))
  )
    throw new Error(`Invalid ${key}`);
  return values;
}

function listener(env: Env, prefix: string) {
  const bind = required(env, `${prefix}_BIND`);
  const port = required(env, `${prefix}_PORT`);
  if (!isIP(bind) || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error(`Invalid ${prefix}_BIND/${prefix}_PORT`);
  return { bind, port: Number(port) };
}

/** Version of the installed package (package.json beside dist/), for the status panel. */
async function packageVersion(): Promise<string> {
  try {
    const { version } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    return typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version)
      ? version
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** Purefect composition root: control plane lanes (Purefect PAPI) plus the in-process model and
 * MCP gateways, which match per-Run credentials locally. Credentials stay in memory only.
 * Core settings use SANDLANE_*; Purefect plugin settings use PUREFECT_*. SPI implementations are
 * assembled explicitly here. */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const env = process.env;
  // Harnesses this Worker drives (the lease's run.harness). The model gateway serves the entry
  // of each Driver's wire, and the lane runs one ephemeral CLI process or thread per Run; the
  // Broker decides per node which of them it has CLI images for.
  const harnesses = { codex: CODEX_CAPABILITIES, "claude-code": CLAUDE_CODE_CAPABILITIES };
  if (
    Object.values(harnesses).some(
      capabilities =>
        !["responses", "anthropic-messages"].includes(capabilities.modelWire) ||
        capabilities.sessionPolicy !== "ephemeral"
    )
  )
    throw new Error("Unsupported Harness capabilities");
  const log: LaneLog = (code, fields) =>
    console.info(
      JSON.stringify({ type: "execution", code, ...fields, at: new Date().toISOString() })
    );

  const runtimeId = required(env, "SANDLANE_RUNTIME_ID");
  const lanes = list(env, "SANDLANE_LANES", ["interactive"], /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
  const concurrency = integer(env, "SANDLANE_CONCURRENCY", 1, 1, 16);
  // Gateway slots follow the lane count: a Run makes model and parallel tool calls, so fixed
  // small limits turned into 429s and CLI retries once several lanes were busy.
  const modelSlots = Math.min(concurrency * 4, 64);
  // The MCP server admits at most 32 concurrent requests.
  const toolSlots = Math.min(concurrency * 4, 32);
  // Optional read-only status panel (SANDLANE_STATUS_PORT): in-memory state only.
  const statusConfig = await statusPanelConfig(env);
  const recorder = statusConfig
    ? new StatusRecorder({
        queues: lanes,
        concurrency,
        recentRuns: statusConfig.recentRuns,
        runIds: statusConfig.runIds,
        limits: { model: modelSlots, tool: toolSlots }
      })
    : undefined;
  const observe: StatusObserver = recorder ? event => recorder.observe(event) : () => {};
  const engineOrigin = required(env, "PUREFECT_ENGINE_ORIGIN");
  const serviceSecret = await readSecret(env, "PUREFECT_SERVICE_SECRET");
  const brokerToken = await readSecret(env, "SANDLANE_BROKER_SERVICE_TOKEN");
  if (serviceSecret === brokerToken) throw new Error("Distinct service credentials required");
  const control = new PapiControlPlane({
    origin: engineOrigin,
    site: required(env, "PUREFECT_CONTROL_SITE"),
    tenant: required(env, "PUREFECT_CONTROL_TENANT"),
    principalId: required(env, "PUREFECT_SERVICE_PRINCIPAL"),
    secret: serviceSecret
  });

  const nodeId = required(env, "SANDLANE_BROKER_NODE_ID");
  const broker = new BrokerClient(required(env, "SANDLANE_BROKER_SOCKET"), brokerToken);
  const status = await broker.status();
  if (status.nodeId !== nodeId || status.ready !== true || status.managedLaunch !== true)
    throw new Error("Broker must be ready with managed gateways");

  const registry = new RunCredentialRegistry();
  // Every tool is enabled by default: the platform authorizes each call with the Run owner's
  // short-lived token, so the user's own permissions apply. SANDLANE_ENABLED_TOOLS narrows the
  // set (the page tool, workspace_action, included). The control plane tools (propose_task,
  // report_task) are listed too: enabled by default, still offered per lease; removing them turns
  // them off.
  const catalog = [
    ...PUREFECT_TOOL_NAMES,
    ...(control.clientActions ? [control.clientActions.name] : []),
    ...(control.controlTools ?? []).map(tool => tool.name)
  ];
  const enabledTools = list(
    env,
    "SANDLANE_ENABLED_TOOLS",
    catalog,
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  );
  if (enabledTools.some(tool => !catalog.includes(tool)))
    throw new Error("Unknown SANDLANE_ENABLED_TOOLS");
  if (!enabledTools.some(tool => PUREFECT_TOOL_NAMES.includes(tool)))
    throw new Error("SANDLANE_ENABLED_TOOLS needs at least one tool gateway tool");
  // The CLI registers the tool gateway under the ToolProvider's server ID; each CLI names the
  // tools its own way (Codex mcp__purefect.<tool>, Claude Code mcp__purefect__<tool>), the page
  // tool included. SANDLANE_MODEL_FUNCTION_INVENTORY overrides per Harness ID.
  const toolServer = PUREFECT_TOOL_SERVER;
  const rawFunctions = env.SANDLANE_MODEL_FUNCTION_INVENTORY;
  if (rawFunctions !== undefined && rawFunctions.length > 16_000)
    throw new Error("Invalid SANDLANE_MODEL_FUNCTION_INVENTORY");
  const functions: unknown =
    rawFunctions === undefined
      ? {
          codex: codexModelFunctions(toolServer, enabledTools),
          "claude-code": claudeCodeModelFunctions(toolServer, enabledTools)
        }
      : JSON.parse(rawFunctions);
  if (
    !functions ||
    typeof functions !== "object" ||
    Array.isArray(functions) ||
    Object.entries(functions).some(
      ([harness, names]) =>
        !Object.hasOwn(harnesses, harness) ||
        !Array.isArray(names) ||
        names.length > 64 ||
        new Set(names).size !== names.length ||
        names.some(v => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v))
    )
  )
    throw new Error("Invalid SANDLANE_MODEL_FUNCTION_INVENTORY");
  // An explicit inventory must admit the enabled control plane tools: they are offered per lease,
  // and a CLI offering one the gateway does not admit has every model request rejected.
  if (rawFunctions !== undefined) {
    const controlNames = (control.controlTools ?? [])
      .map(tool => tool.name)
      .filter(name => enabledTools.includes(name));
    const missing = missingFunctions(functions as Record<string, string[]>, {
      codex: codexModelFunctions(toolServer, controlNames),
      "claude-code": claudeCodeModelFunctions(toolServer, controlNames)
    });
    if (missing.length)
      throw new Error(
        `SANDLANE_MODEL_FUNCTION_INVENTORY lacks the enabled control plane tools (${missing.join(", ")}): add them, or remove the tools from SANDLANE_ENABLED_TOOLS`
      );
  }
  // Built-in file and command functions per Harness, admitted for file-mode Runs only
  // (conversation files in the sandbox). SANDLANE_MODEL_FILE_FUNCTION_INVENTORY overrides them,
  // e.g. when a CLI version names its shell tool differently.
  const rawFileFunctions = env.SANDLANE_MODEL_FILE_FUNCTION_INVENTORY;
  if (rawFileFunctions !== undefined && rawFileFunctions.length > 2_000)
    throw new Error("Invalid SANDLANE_MODEL_FILE_FUNCTION_INVENTORY");
  const fileFunctions: unknown =
    rawFileFunctions === undefined
      ? { codex: [...CODEX_FILE_FUNCTIONS], "claude-code": [...CLAUDE_CODE_FILE_FUNCTIONS] }
      : JSON.parse(rawFileFunctions);
  if (
    !fileFunctions ||
    typeof fileFunctions !== "object" ||
    Array.isArray(fileFunctions) ||
    Object.entries(fileFunctions).some(
      ([harness, names]) =>
        !Object.hasOwn(harnesses, harness) ||
        !Array.isArray(names) ||
        names.length > 8 ||
        new Set(names).size !== names.length ||
        names.some(v => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v))
    )
  )
    throw new Error("Invalid SANDLANE_MODEL_FILE_FUNCTION_INVENTORY");
  const messagesAuth = env.SANDLANE_MODEL_MESSAGES_AUTH ?? "x-api-key";
  if (!["x-api-key", "bearer", "both"].includes(messagesAuth))
    throw new Error("Invalid SANDLANE_MODEL_MESSAGES_AUTH");

  // Model gateway: Responses and Messages over TLS, upstream from the lease's model service.
  const modelListener = listener(env, "SANDLANE_MODEL_GATEWAY");
  const modelAuthority = new LocalModelAuthority(
    registry,
    {
      functions: functions as Record<string, string[]>,
      // Harness tools built on the provider's web search; each Run's web access decides.
      webFunctions: { "claude-code": CLAUDE_CODE_WEB_FUNCTIONS },
      fileFunctions: fileFunctions as Record<string, string[]>,
      maxOutputTokens: integer(env, "SANDLANE_MODEL_MAX_OUTPUT_TOKENS", 32_000, 16, 1_000_000)
    },
    defaultUpstreams(
      messagesAuth as MessagesAuth,
      recorder
        ? {
            log: (code, fields) => {
              console.debug(
                JSON.stringify({ type: "model-upstream", level: "debug", code, ...fields })
              );
              if (code === "UPSTREAM_PRECONNECTED")
                observe({
                  type: "upstream.preconnect",
                  ok: true,
                  elapsedMs: Number(fields.elapsedMs)
                });
              else if (code === "UPSTREAM_PRECONNECT_FAILED")
                observe({ type: "upstream.preconnect", ok: false, error: String(fields.error) });
            }
          }
        : undefined
    )
  );
  const modelLimits = {
    maxActive: modelSlots,
    // Whole streamed call, including long reasoning; the Run deadline still applies.
    timeoutMs: integer(env, "SANDLANE_MODEL_GATEWAY_TIMEOUT_MS", 600_000, 10_000, 1_800_000)
  };
  const modelGateway = new ModelGateway(modelAuthority, modelAuthority, modelAuthority.provider, {
    maxConcurrent: modelLimits.maxActive,
    timeoutMs: modelLimits.timeoutMs,
    receiptTimeoutMs: 5_000
  });
  const [modelKey, modelCert] = await Promise.all([
    pem(required(env, "SANDLANE_MODEL_GATEWAY_TLS_KEY_FILE")),
    pem(required(env, "SANDLANE_MODEL_GATEWAY_TLS_CERT_FILE"))
  ]);
  const modelServer = createModelServer(
    { key: modelKey, cert: modelCert },
    required(env, "SANDLANE_MODEL_GATEWAY_HOSTNAME"),
    // With the panel on, calls are counted (in flight, failed) around the gateway.
    recorder
      ? {
          respond: (...args) => recorder.track("model", () => modelGateway.respond(...args)),
          messages: (...args) => recorder.track("model", () => modelGateway.messages(...args))
        }
      : modelGateway,
    modelAuthority.lookup,
    value => console.info(JSON.stringify({ type: "model-timing", ...value })),
    modelLimits
  );

  // MCP tool gateway (Purefect tools and the page tool): platform calls use the Run owner's
  // current agent token; the page tool is relayed through the Run's lane.
  const toolListener = listener(env, "SANDLANE_TOOL_MCP");
  const module = required(env, "PUREFECT_CLIENT_MODULE");
  if (!isAbsolute(module)) throw new Error("PUREFECT_CLIENT_MODULE must be absolute");
  const ManagedClient = createRequire(import.meta.url)(module) as new (
    settings: Parameters<ManagedPurefectClientFactory>[0]
  ) => ReturnType<ManagedPurefectClientFactory>;
  if (typeof ManagedClient !== "function") throw new Error("Invalid managed client export");
  // purefect-client ships its API documentation beside its module (apis/).
  let docs: ApiDocs;
  try {
    docs = await ApiDocs.open(apiDocsDirectory(module));
  } catch {
    throw new Error("purefect-client apis/ directory unavailable beside PUREFECT_CLIENT_MODULE");
  }
  const targetRef = env.SANDLANE_TOOL_TARGET_REF ?? toolServer;
  const targetVersion = integer(env, "SANDLANE_TOOL_TARGET_VERSION", 1, 1, 1_000_000);
  const installed = installPurefectTools(
    {
      gateway: env.PUREFECT_TOOL_ORIGIN ?? engineOrigin,
      targetRef,
      targetVersion,
      docs
    },
    settings => new ManagedClient(settings)
  );
  const toolAuthority = new LocalToolAuthority(
    registry,
    { serverId: toolServer, targetRef, targetVersion },
    installed.adapter.tools
  );
  const toolGateway = new ToolGateway(
    toolAuthority,
    toolAuthority,
    new Map([[toolServer, toolAuthority.bind(installed.adapter)]]),
    { concurrent: toolSlots, timeoutMs: 30_000, receiptMs: 5_000 },
    // Audit: tool, the API code and the outcome; never parameters or results.
    entry => {
      observe({ type: "run.tool", run: entry.run, ok: entry.outcome === "SUCCEEDED" });
      console.info(
        JSON.stringify({
          type: "execution",
          code: "TOOL_CALL",
          run: entry.run,
          tool: entry.tool,
          ...entry.fields,
          outcome: entry.outcome,
          ...(entry.code ? { error: entry.code } : {}),
          ms: entry.ms,
          at: new Date().toISOString()
        })
      );
    }
  );
  const [toolKey, toolCert] = await Promise.all([
    pem(required(env, "SANDLANE_TOOL_MCP_TLS_KEY_FILE")),
    pem(required(env, "SANDLANE_TOOL_MCP_TLS_CERT_FILE"))
  ]);
  const mcpServer = createToolMcpServer(
    { key: toolKey, cert: toolCert },
    required(env, "SANDLANE_TOOL_MCP_HOSTNAME"),
    recorder
      ? { invoke: (...args) => recorder.track("tool", () => toolGateway.invoke(...args)) }
      : toolGateway,
    toolAuthority.lookup,
    installed.adapter.tools,
    "sandlane-tools"
  );

  const reasoningEffort = env.SANDLANE_REASONING_EFFORT;
  if (reasoningEffort !== undefined && !["low", "medium", "high"].includes(reasoningEffort))
    throw new Error("Invalid SANDLANE_REASONING_EFFORT");
  const instructionProfile = env.PUREFECT_INSTRUCTION_PROFILE ?? "default";
  if (!["default", "business"].includes(instructionProfile))
    throw new Error("Invalid PUREFECT_INSTRUCTION_PROFILE");
  // The Purefect decorator adds the platform tools, action links and page tool to the business
  // instructions; the default profile keeps each CLI's own system prompt.
  let context: ContextProvider = new PurefectContext(
    new FrozenInputContext(instructionProfile === "business" ? businessInstructions : undefined),
    {
      enabledTools,
      ...(control.clientActions ? { clientAction: control.clientActions } : {})
    }
  );
  // Optional memory plugin (single-host SQLite); loaded only when enabled.
  let memory: { close(): Promise<void> } | undefined;
  if (env.SANDLANE_MEMORY_ENABLED === "true") {
    const directory = required(env, "SANDLANE_MEMORY_DIRECTORY");
    if (!isAbsolute(directory)) throw new Error("SANDLANE_MEMORY_DIRECTORY must be absolute");
    const { openLocalMemory } = await import("../plugins/memory/runtime.js");
    const opened = await openLocalMemory(directory, env);
    context = opened.wrap(context);
    memory = opened;
  }
  const driverDefaults = {
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {}),
    onTiming: (runId: string, phase: string, elapsedMs: number) => {
      log("TIMING", { run: runId, phase, elapsedMs });
      observe({ type: "run.phase", run: runId, phase, elapsedMs });
    }
  };
  const drivers: Record<keyof typeof harnesses, BrokerDriverFactory> = {
    codex: binding =>
      new CodexRunAdapter({
        workspace: "/workspace",
        ...driverDefaults,
        transport: new BrokerHarnessTransport(broker, binding)
      }),
    "claude-code": binding =>
      new ClaudeCodeDriver({
        ...driverDefaults,
        transport: new BrokerHarnessTransport(broker, binding)
      })
  };
  const launcher = new BrokerSandboxLauncher(broker, nodeId, drivers);
  // Memory-aware claiming: a lane claims only while the host has this much memory available
  // (typical sandbox peak plus a reserve). 0 (default) turns the check off.
  const admissionMiB = integer(env, "SANDLANE_ADMISSION_MEMORY_MIB", 0, 0, 1_048_576);
  const admission = admissionMiB ? new MemoryAdmission(admissionMiB * 1024 * 1024) : undefined;
  if (admission && (await readMemAvailable()) === undefined)
    log("ADMISSION_MEMORY_UNKNOWN", { source: "/proc/meminfo" });

  let statusEndpoint:
    | { server: ReturnType<typeof createStatusServer>; port: number; bind: string }
    | undefined;
  if (recorder && statusConfig) {
    const panel = new StatusPanel(
      recorder,
      {
        version: await packageVersion(),
        startedAt,
        runtimeId,
        nodeId,
        harnesses: Object.keys(harnesses)
      },
      signal => broker.status(signal)
    );
    statusEndpoint = {
      server: createStatusServer(panel, statusConfig),
      port: statusConfig.port,
      bind: statusConfig.bind
    };
    log("STATUS_PANEL_LISTENING", {
      bind: statusConfig.bind,
      port: statusConfig.port,
      auth: statusConfig.token ? "token" : "none"
    });
  }
  const runtime = await createRuntime({
    controlPlane: control,
    sandbox: launcher,
    credentials: registry,
    concurrency,
    lane: {
      runtimeId,
      lanes,
      enabledTools,
      ...(env.SANDLANE_MODEL_ALIAS ? { modelAlias: env.SANDLANE_MODEL_ALIAS } : {}),
      toolServer,
      context,
      admit: credential => {
        modelAuthority.admit(credential);
        // Claim time: open the upstream connection while the sandbox is being prepared.
        modelAuthority.warm(credential);
      },
      log,
      ...(admission ? { admission } : {})
    },
    ...(recorder ? { observeLane: index => recorder.lane(index) } : {}),
    endpoints: [
      { server: modelServer, ...modelListener },
      { server: mcpServer, ...toolListener },
      ...(statusEndpoint ? [statusEndpoint] : [])
    ],
    ...(memory ? { resources: [memory] } : {}),
    log
  });
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (grace) return;
    // Drain first: running Runs finish and settle; after the grace period they are cancelled.
    runtime.drain();
    grace = setTimeout(
      () => void runtime.close(),
      integer(env, "SANDLANE_DRAIN_MS", 60_000, 1_000, 600_000)
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await runtime.done;
  } finally {
    clearTimeout(grace);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await runtime.close();
  }
}

main().catch(error => {
  // Configuration errors name the variable, never its value.
  console.error(
    `SANDLANE_STARTUP_FAILED: ${error instanceof Error && /^[A-Za-z_ ./:0-9-]{1,200}$/.test(error.message) ? error.message : "check configuration"}`
  );
  process.exitCode = 1;
});
