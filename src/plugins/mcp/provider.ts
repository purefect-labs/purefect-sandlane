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
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolGatewayError,
  ToolCallFailed,
  type ToolProvider,
  type ToolDescriptor,
  type ToolIdentity
} from "../../spi/tool-provider.js";
import { readSecret } from "../../common/env.js";
import { ManagedStdioTransport, mcpFetch } from "./transports.js";

export interface McpToolConfig {
  alias: string;
  remoteName: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}
export interface McpServerConfig {
  id: string;
  transport:
    | { type: "http"; url: string; caFile?: string }
    | { type: "stdio"; command: string; args: string[]; cwd: string; env?: Record<string, string> };
  tools: McpToolConfig[];
}
export interface McpBinding {
  server: string;
  tenantId: string;
  /** Exact user ID, or explicitly '*' for all users in this tenant. */
  userId: string;
  tools: string[];
  /** HTTP header -> private secret file. Values never come from tool arguments. */
  headerSecrets?: Record<string, { file: string; prefix?: "Bearer " }>;
  /** stdio environment variable -> private secret file. */
  envSecrets?: Record<string, string>;
}
export interface McpConfig {
  servers: McpServerConfig[];
  bindings: McpBinding[];
  maxConcurrent?: number;
  timeoutMs?: number;
}
const name = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const denied = () => {
  throw new ToolGatewayError("MCP_ACCESS_OR_CONFIG_REJECTED");
};
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !allowed.includes(k))
  )
    denied();
}
function closedSchema(value: unknown, depth = 0): void {
  if (depth > 16 || !value || typeof value !== "object" || Array.isArray(value)) denied();
  const schema = value as Record<string, unknown>;
  if (
    schema.$ref ||
    schema.$dynamicRef ||
    schema.$id ||
    schema.patternProperties ||
    schema.allOf ||
    schema.anyOf ||
    schema.oneOf ||
    schema.not
  )
    denied();
  if (schema.type === "object") {
    if (
      schema.additionalProperties !== false ||
      !schema.properties ||
      typeof schema.properties !== "object"
    )
      denied();
    for (const entry of Object.values(schema.properties as object)) closedSchema(entry, depth + 1);
  } else if (schema.type === "array") closedSchema(schema.items, depth + 1);
  else if (!["string", "number", "integer", "boolean", "null"].includes(String(schema.type)))
    denied();
}

/** Admin-owned config only: no executable loading or credential selection from a Run/prompt. */
export function parseMcpConfig(raw: unknown): McpConfig {
  keys(raw, ["servers", "bindings", "maxConcurrent", "timeoutMs"]);
  if (Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024) denied();
  const config = JSON.parse(JSON.stringify(raw)) as McpConfig;
  if (
    !Array.isArray(config.servers) ||
    !config.servers.length ||
    config.servers.length > 16 ||
    !Array.isArray(config.bindings) ||
    config.bindings.length > 256
  )
    denied();
  if (
    !Number.isSafeInteger(config.maxConcurrent ?? 8) ||
    (config.maxConcurrent ?? 8) < 1 ||
    (config.maxConcurrent ?? 8) > 32 ||
    !Number.isSafeInteger(config.timeoutMs ?? 20_000) ||
    (config.timeoutMs ?? 20_000) < 100 ||
    (config.timeoutMs ?? 20_000) > 25_000
  )
    denied();
  const ids = new Set<string>(),
    aliases = new Set<string>();
  for (const server of config.servers) {
    keys(server, ["id", "transport", "tools"]);
    if (typeof server.id !== "string" || !name.test(server.id) || ids.has(server.id)) denied();
    ids.add(server.id);
    const t = server.transport;
    keys(
      t,
      t?.type === "http" ? ["type", "url", "caFile"] : ["type", "command", "args", "cwd", "env"]
    );
    if (t.type === "http") {
      const url = new URL(t.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (t.caFile && !isAbsolute(t.caFile))
      )
        denied();
      t.url = url.href;
    } else if (t.type === "stdio") {
      if (
        !isAbsolute(t.command) ||
        !isAbsolute(t.cwd) ||
        !Array.isArray(t.args) ||
        t.args.length > 64 ||
        t.args.some(a => typeof a !== "string" || a.length > 4096 || a.includes("\0"))
      )
        denied();
      for (const [key, value] of Object.entries(t.env ?? {}))
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== "string" ||
          value.includes("\0")
        )
          denied();
    } else denied();
    if (!Array.isArray(server.tools) || !server.tools.length) denied();
    for (const tool of server.tools) {
      keys(tool, ["alias", "remoteName", "description", "readOnly", "inputSchema"]);
      if (
        typeof tool.alias !== "string" ||
        !name.test(tool.alias) ||
        aliases.has(tool.alias) ||
        typeof tool.remoteName !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.remoteName) ||
        typeof tool.description !== "string" ||
        tool.description.length > 2048 ||
        typeof tool.readOnly !== "boolean" ||
        tool.inputSchema?.type !== "object"
      )
        denied();
      closedSchema(tool.inputSchema);
      aliases.add(tool.alias);
    }
  }
  if (aliases.size > 48) denied();
  const bindings = new Set<string>();
  for (const binding of config.bindings) {
    keys(binding, ["server", "tenantId", "userId", "tools", "headerSecrets", "envSecrets"]);
    const server = config.servers.find(s => s.id === binding.server);
    if (
      !server ||
      typeof binding.tenantId !== "string" ||
      !binding.tenantId ||
      binding.tenantId === "*" ||
      typeof binding.userId !== "string" ||
      !binding.userId ||
      !Array.isArray(binding.tools) ||
      !binding.tools.length ||
      new Set(binding.tools).size !== binding.tools.length ||
      binding.tools.some(t => !server.tools.some(tool => tool.alias === t))
    )
      denied();
    const key = JSON.stringify([binding.server, binding.tenantId, binding.userId]);
    if (bindings.has(key)) denied();
    bindings.add(key);
    if (
      (server!.transport.type === "http" && binding.envSecrets) ||
      (server!.transport.type === "stdio" && binding.headerSecrets)
    )
      denied();
    const headerNames = new Set<string>();
    for (const [header, secret] of Object.entries(binding.headerSecrets ?? {})) {
      if (!/^(authorization|x-api-key|api-key)$/i.test(header)) denied();
      if (headerNames.has(header.toLowerCase())) denied();
      headerNames.add(header.toLowerCase());
      keys(secret, ["file", "prefix"]);
      if (!isAbsolute(secret.file) || (secret.prefix !== undefined && secret.prefix !== "Bearer "))
        denied();
    }
    for (const [key, file] of Object.entries(binding.envSecrets ?? {}))
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        !isAbsolute(file) ||
        /^(HOME|PATH|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH)$/i.test(key)
      )
        denied();
  }
  return config;
}

/** Load bounded deployment configuration; secrets are referenced, never embedded in this file. */
export async function loadMcpToolProvider(file: string): Promise<McpToolProvider> {
  if (!isAbsolute(file)) denied();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 || (stat.mode & 0o022) !== 0) denied();
    return new McpToolProvider(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

/** Shared catalog, per-invocation clients, credentials and processes. Never forwards the
 * platform agent token to external MCPs. Unknown outcomes are never automatically retried. */
export class McpToolProvider implements ToolProvider {
  readonly tools: readonly ToolDescriptor[];
  readonly #config: McpConfig;
  readonly #stop = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  #broken = false;
  constructor(config: unknown) {
    this.#config = parseMcpConfig(config);
    const validator = new AjvJsonSchemaValidator();
    this.tools = Object.freeze(
      this.#config.servers.flatMap(server =>
        server.tools.map(tool => {
          const check = validator.getValidator(tool.inputSchema);
          return Object.freeze({
            alias: tool.alias,
            version: 1,
            readOnly: tool.readOnly,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
            validateParams(params: Readonly<Record<string, unknown>>) {
              if (Buffer.byteLength(JSON.stringify(params)) > 64 * 1024 || !check(params).valid)
                throw new ToolGatewayError("INVALID_TOOL_ARGUMENTS");
            }
          });
        })
      )
    );
  }
  validate(input: Parameters<ToolProvider["validate"]>[0]): void {
    const tool = this.tools.find(t => t.alias === input.toolAlias);
    if (!tool) denied();
    tool!.validateParams(input.arguments);
  }
  confirmation(input: Parameters<ToolProvider["validate"]>[0], operations: readonly string[]) {
    const tool = this.tools.find(t => t.alias === input.toolAlias);
    if (tool && !tool.readOnly && (operations.includes("*") || operations.includes(tool.alias)))
      return { title: tool.alias, summary: "Invoke the configured external MCP tool." };
    return undefined;
  }
  invoke(
    input: Parameters<ToolProvider["invoke"]>[0],
    identity: Readonly<ToolIdentity>,
    _accessToken: string,
    signal: AbortSignal,
    expiresAt: number
  ): Promise<unknown> {
    try {
      this.validate(input);
    } catch {
      throw new ToolCallFailed("INVALID_TOOL_ARGUMENTS", true);
    }
    if (
      this.#stop.signal.aborted ||
      this.#broken ||
      this.#active.size >= (this.#config.maxConcurrent ?? 8)
    )
      return Promise.reject(new ToolCallFailed("MCP_UNAVAILABLE_OR_BUSY", true));
    const work = this.#invoke(input, identity, signal, expiresAt);
    this.#active.add(work);
    void work.finally(() => this.#active.delete(work)).catch(() => {});
    return work;
  }
  async #invoke(
    input: Parameters<ToolProvider["invoke"]>[0],
    identity: Readonly<ToolIdentity>,
    signal: AbortSignal,
    expiresAt: number
  ): Promise<unknown> {
    const server = this.#config.servers.find(s => s.tools.some(t => t.alias === input.toolAlias))!;
    const candidates = this.#config.bindings.filter(
      b => b.server === server.id && b.tenantId === identity.tenantId
    );
    // Exact user binding replaces (never merges with) the tenant-wide grant.
    const binding =
      candidates.find(b => b.userId === identity.userId) ?? candidates.find(b => b.userId === "*");
    if (!binding?.tools.includes(input.toolAlias))
      throw new ToolCallFailed("MCP_ACCESS_OR_CONFIG_REJECTED", true);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new ToolCallFailed("MCP_CREDENTIAL_EXPIRED", true);
    const stop = AbortSignal.any([
      signal,
      this.#stop.signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(this.#config.timeoutMs ?? 20_000, expiresAt - Date.now()))
      )
    ]);
    if (stop.aborted) throw new ToolCallFailed("MCP_CALL_CANCELLED", true);
    const secrets: string[] = [];
    let transport: Transport | undefined;
    const client = new Client(
      { name: "sandlane-mcp-upstream", version: "0.1.0" },
      { capabilities: {} }
    );
    let http: StreamableHTTPClientTransport | undefined;
    let connecting = false;
    const abort = () => {
      void transport?.close().catch(() => {
        this.#broken = true;
      });
    };
    try {
      const get = async (file: string) => {
        const secret = await readSecret({ MCP_SECRET_FILE: file }, "MCP_SECRET");
        secrets.push(secret);
        stop.throwIfAborted();
        return secret;
      };
      if (server.transport.type === "http") {
        const headers: Record<string, string> = {};
        for (const [header, ref] of Object.entries(binding!.headerSecrets ?? {}))
          headers[header] = (ref.prefix ?? "") + (await get(ref.file));
        const ca = server.transport.caFile
          ? await readFile(server.transport.caFile, "utf8")
          : undefined;
        transport = http = new StreamableHTTPClientTransport(new URL(server.transport.url), {
          requestInit: { headers },
          fetch: mcpFetch(server.transport.url, stop, ca),
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 100,
            maxReconnectionDelay: 100,
            reconnectionDelayGrowFactor: 1
          }
        });
      } else {
        const env = { ...server.transport.env };
        for (const [key, file] of Object.entries(binding!.envSecrets ?? {}))
          env[key] = await get(file);
        transport = new ManagedStdioTransport({
          command: server.transport.command,
          args: server.transport.args,
          cwd: server.transport.cwd,
          env
        });
      }
      stop.throwIfAborted();
      stop.addEventListener("abort", abort, { once: true });
      connecting = true;
      await client.connect(transport, { signal: stop, timeout: this.#config.timeoutMs ?? 20_000 });
      const tool = server.tools.find(t => t.alias === input.toolAlias)!;
      const result = await client.callTool(
        { name: tool.remoteName, arguments: input.arguments },
        undefined,
        { signal: stop, timeout: this.#config.timeoutMs ?? 20_000 }
      );
      stop.throwIfAborted();
      const encoded = JSON.stringify(result);
      if (
        Buffer.byteLength(encoded) > 1024 * 1024 ||
        secrets.some(
          secret =>
            encoded.includes(secret) || encoded.includes(JSON.stringify(secret).slice(1, -1))
        )
      )
        throw Error("MCP_RESULT_REJECTED");
      if (result.isError) {
        // Only an admin-declared read-only tool can establish absence of writes here.
        // Never forward arbitrary upstream text or identifiers as corrective hints.
        const details = result.structuredContent;
        const code =
          details && typeof details === "object" && "error" in details ? details.error : undefined;
        const reason =
          typeof code === "string" &&
          ["INVALID_ARGUMENTS", "NOT_FOUND", "ACCESS_DENIED", "RATE_LIMITED"].includes(code)
            ? code
            : undefined;
        throw new ToolCallFailed("MCP_TOOL_ERROR", tool.readOnly, reason);
      }
      return result;
    } catch (error) {
      if (error instanceof ToolCallFailed) throw error;
      throw new ToolCallFailed(
        connecting ? "MCP_CALL_FAILED_OR_UNKNOWN" : "MCP_PREPARATION_FAILED",
        !connecting
      );
    } finally {
      stop.removeEventListener("abort", abort);
      try {
        // Best effort remote deletion bounded separately; expiry/cancellation may already close it.
        if (http?.sessionId && !stop.aborted) await http.terminateSession();
      } catch {
        /* The remote service must also expire abandoned sessions. */
      }
      try {
        await transport?.close();
        await client.close();
      } catch {
        this.#broken = true;
        throw new ToolCallFailed("MCP_CLEANUP_FAILED", false);
      }
    }
  }
  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#active]);
    if (this.#broken) throw new ToolGatewayError("MCP_CLEANUP_FAILED");
  }
}

/** Borrowed providers. The caller retains lifecycle ownership; duplicate aliases are rejected. */
export function combineToolProviders(...providers: ToolProvider[]): ToolProvider {
  const byName = new Map<string, ToolProvider>();
  for (const provider of providers)
    for (const tool of provider.tools) {
      if (byName.has(tool.alias)) throw Error("DUPLICATE_TOOL_ALIAS");
      byName.set(tool.alias, provider);
    }
  const select = (name: string) => {
    const provider = byName.get(name);
    if (!provider) denied();
    return provider!;
  };
  return {
    tools: Object.freeze(providers.flatMap(p => [...p.tools])),
    validate: (input, deployment) => select(input.toolAlias).validate(input, deployment),
    summarize: input => select(input.toolAlias).summarize?.(input) ?? {},
    confirmation: (input, operations) => select(input.toolAlias).confirmation?.(input, operations),
    invoke: (input, ...rest) => select(input.toolAlias).invoke(input, ...rest)
  };
}
