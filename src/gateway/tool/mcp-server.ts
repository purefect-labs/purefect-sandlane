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
import https from "node:https";
import type { ServerOptions } from "node:https";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolGateway, ToolRuntime } from "./gateway.js";
import { CONFIRMATION_CODES, ToolCallFailed, ToolGatewayError, type ToolDescriptor } from "../../spi/tool-provider.js";

/** Authenticated control-plane allocation lookup, NOT values supplied in MCP params or headers.
 * Production uses fresh Engine introspection, not a second Host identity registry.
 * Lookup must reject revoked/expired allocations and bind this exact TOOL capability.
 * This lookup cannot replace Engine's current authorization on every invocation. */
export interface McpRunBinding {
  runtime: Readonly<ToolRuntime>;
  expiresAt: number;
  enabledTools: readonly string[];
  /** The Run's client action (see RunClientAction): listed and callable for this Run only. */
  clientAction?: McpClientAction;
  /** Calls may wait for the user's approval (approval bridge): they get the client action deadline. */
  confirms?: boolean;
  /** The Run's control plane tools (see RunControlTool): listed and callable for this Run only. */
  controlTools?: readonly McpControlTool[];
}
export interface McpControlTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
  /** Resolves with the result for the model; `callId` comes from the tools/call `_meta` when the CLI
   * sends one. Never needs the Run owner's token. */
  call(args: unknown, signal: AbortSignal, callId?: string): Promise<{ readonly text: string; readonly failed?: boolean }>;
}

/** The model's tool call ID a CLI puts in the tools/call `_meta`: Claude Code sends
 * `claudecode/toolUseId` (unchanged when the same call is resent). Whether and under which key
 * Codex 0.154 sends one is unverified; without it the caller makes its own. Only bounded strings
 * without control characters are taken. */
const TOOL_CALL_ID_KEYS = ["claudecode/toolUseId"] as const;
function toolCallIdOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  for (const key of TOOL_CALL_ID_KEYS) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value)) return value;
  }
  return undefined;
}
export interface McpClientAction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
  /** Resolves with the receipt for the model; it never needs the Run owner's token. */
  call(args: unknown, signal: AbortSignal): Promise<unknown>;
}
export type McpRunLookup = (capability: string, signal: AbortSignal) => Promise<McpRunBinding | null>;

/** Whole request (upload, lookup, call, receipt settlement), and a client action's request: the lane
 * answers a client action within 55s; every hop must outlast it (the relay idles out at 60s). */
const REQUEST_DEADLINE_MS = 45_000;
const CLIENT_ACTION_DEADLINE_MS = 58_000;
/** Request body: a client action may carry 64 KiB of arguments; tool parameters stay under the
 * tool gateway's own limit. */
const BODY_LIMIT = 72_000;
const RESULT_LIMIT = 64_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** MCP hints derived from the provider's classification. */
const annotations = (readOnly: boolean) => readOnly
  ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  : { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const CONFIRMATION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  [CONFIRMATION_CODES.rejected]: "The user declined this call when asked to confirm it, so it was not executed. Tell the user it was declined; do not retry unless the user asks.",
  [CONFIRMATION_CODES.timeout]: "This call needs the user's confirmation, but no answer arrived in time (no reply, or no workbench window open), so it was not executed. Tell the user; try again only if the user asks.",
  [CONFIRMATION_CODES.unavailable]: "This call needs the user's confirmation, which cannot be requested in this session, so it was not executed. Tell the user.",
  [CONFIRMATION_CODES.unattended]: "This call needs a person's confirmation, which an assigned task cannot ask for (no one is at a workbench), so it was not executed. Do not retry it; in the summary of your task report (report_task) say who needs to confirm what."
});

/** Text the model sees for a failed call: a provider-classified failure code, never dependency
 * errors, bearer tokens or raw authority/credential objects. A call that did not run for want of
 * approval says so, so the model does not report it as a permission problem. */
function failureText(error: unknown): string {
  if (error instanceof ToolCallFailed && Object.hasOwn(CONFIRMATION_TEXT, error.code))
    return `${CONFIRMATION_TEXT[error.code]} (${error.code})`;
  if (error instanceof ToolCallFailed)
    return error.definite
      ? `The call failed (${error.code}${error.reason ? `: ${error.reason}` : ""}). Check the request against the tool's documentation before trying again.`
      : `The call's outcome is unknown (${error.code}); do not automatically retry.`;
  return "Tool call unavailable; do not automatically retry.";
}

/** HTTPS-only stateless MCP boundary. Each POST owns its own protocol instance and immutable
 * Run binding; there is no global MCP session, user token or client selected identity.
 * Provider tools may write: the downstream service authorizes the Run owner's token. No CLI
 * reconnect/retry safety for writes is claimed (calls are never retried here). */
export function createToolMcpServer(tls: ServerOptions, hostname: string, gateway: Pick<ToolGateway, "invoke">,
  lookup: McpRunLookup, tools: readonly Readonly<ToolDescriptor>[], serverName = "sandlane-tools"): https.Server {
  if (!tls.key || !tls.cert || !/^[a-zA-Z0-9.-]+$/.test(hostname)) throw Error("Explicit MCP TLS identity required");
  if (tools.some(tool => typeof tool.readOnly !== "boolean")) throw Error("Tool classification required");
  const published = new Map(tools.map(tool => [tool.alias, tool]));
  let active = 0;
  const server = https.createServer({ ...tls, minVersion: "TLSv1.2", handshakeTimeout: 5000, maxHeaderSize: 8192,
    headersTimeout: 5000, requestTimeout: 10_000 }, async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const fail = (status: number) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "MCP_REQUEST_REJECTED" }));
    };
    const count = (name: string) => req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length;
    if (count("host") !== 1 || req.headers.host?.split(":")[0]?.toLowerCase() !== hostname.toLowerCase() ||
        req.headers.origin !== undefined || req.headers["mcp-session-id"] !== undefined) { fail(403); return; }
    if (req.url !== "/mcp") { fail(404); return; }
    if (count("authorization") !== 1 || !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? "")) { fail(401); return; }
    if (req.method !== "POST") { res.setHeader("allow", "POST"); fail(405); return; }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"]) { fail(415); return; }
    if (active >= 32) { fail(429); return; }
    active++;
    const abort = new AbortController();
    let protocol: Server | undefined;
    let cleaned = false;
    let deadline: NodeJS.Timeout;
    const clean = () => {
      if (cleaned) return;
      cleaned = true; clearTimeout(deadline); active--; abort.abort();
      void protocol?.close().catch(() => {});
    };
    res.once("close", clean);
    // Includes body upload, lookup and downstream receipt settlement. No slot lives forever.
    const expire = () => { fail(504); clean(); req.destroy(); };
    deadline = setTimeout(expire, REQUEST_DEADLINE_MS);
    const bodyDeadline = setTimeout(() => { fail(408); clean(); req.destroy(); }, 5000);
    try {
      const capability = req.headers.authorization!.slice(7);
      const binding = await lookup(capability, abort.signal);
      abort.signal.throwIfAborted();
      const action = binding?.clientAction;
      const controls = binding?.controlTools ?? [];
      if (!binding || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= Date.now() ||
          !binding.runtime || ![binding.runtime.runtimeId, binding.runtime.allocationId].every(v =>
            typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v)) ||
          !Array.isArray(binding.enabledTools) || (binding.enabledTools.length < 1 && !action && !controls.length) ||
          binding.enabledTools.length > published.size ||
          new Set(binding.enabledTools).size !== binding.enabledTools.length || binding.enabledTools.some(t => !published.has(t)) ||
          (action && (!NAME.test(action.name) || published.has(action.name) || typeof action.call !== "function" ||
            !Number.isSafeInteger(action.expiresAt) || action.expiresAt <= Date.now())) ||
          // Control plane tools may not shadow gateway tools, the client action or each other.
          !Array.isArray(controls) || controls.length > 8 ||
          new Set(controls.map(tool => tool.name)).size !== controls.length ||
          controls.some(tool => !NAME.test(tool.name) || published.has(tool.name) || tool.name === action?.name ||
            typeof tool.call !== "function" || !Number.isSafeInteger(tool.expiresAt) || tool.expiresAt <= Date.now())) {
        fail(401); return;
      }
      const controlByName = new Map(controls.map(tool => [tool.name, tool]));
      const runtime = Object.freeze({ ...binding.runtime });
      const allowed = new Set(binding.enabledTools);
      const expiresAt = binding.expiresAt;
      let callDeadline = REQUEST_DEADLINE_MS;
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > BODY_LIMIT) { fail(413); return; }
        chunks.push(bytes);
      }
      clearTimeout(bodyDeadline);
      if (expiresAt <= Date.now()) { fail(401); return; }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail(400); return; }
      // No batches or client-selected routing/identity fields. Schema validation still runs in SDK.
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(k => !["jsonrpc", "id", "method", "params"].includes(k))) { fail(400); return; }
      const message = body as Record<string, unknown>;
      if (message.method === "tools/call") {
        const p = message.params;
        if (!p || typeof p !== "object" || Array.isArray(p) ||
            Object.keys(p).some(k => !["name", "arguments", "_meta"].includes(k))) { fail(400); return; }
        // A client action waits for the user's client: it gets its own, longer deadline.
        if (action && (p as Record<string, unknown>).name === action.name) {
          clearTimeout(deadline);
          deadline = setTimeout(expire, CLIENT_ACTION_DEADLINE_MS);
        } else if (size > 40_000) { fail(413); return; }
        else if (binding.confirms === true) {
          // The call may wait for the user's approval before it runs.
          clearTimeout(deadline);
          deadline = setTimeout(expire, CLIENT_ACTION_DEADLINE_MS);
          callDeadline = CLIENT_ACTION_DEADLINE_MS;
        }
      }
      protocol = new Server({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        ...[...allowed].map(name => {
          const tool = published.get(name)!;
          return { name, description: tool.description,
            inputSchema: { ...tool.inputSchema, type: "object" as const }, annotations: annotations(tool.readOnly) };
        }),
        ...(action ? [{ name: action.name, description: action.description,
          inputSchema: { ...action.inputSchema, type: "object" as const },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }] : []),
        ...controls.map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: { ...tool.inputSchema, type: "object" as const },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }))
      ] }));
      protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const args = request.params.arguments ?? {};
        const control = controlByName.get(request.params.name);
        if (control) {
          try {
            if (control.expiresAt <= Date.now()) throw Error();
            // Bound to this Run: the capability resolved the binding, the lane completes the call
            // through the control plane.
            const result = await control.call(args, AbortSignal.any([abort.signal, extra.signal]),
              toolCallIdOf(request.params._meta));
            if (!result || typeof result.text !== "string" || Buffer.byteLength(result.text) > RESULT_LIMIT) throw Error();
            return { ...(result.failed ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
          } catch {
            return { isError: true, content: [{ type: "text" as const, text: "Tool call unavailable; do not automatically retry." }] };
          }
        }
        if (action && request.params.name === action.name) {
          try {
            if (action.expiresAt <= Date.now()) throw Error();
            // Bound to this Run: the capability resolved the binding, the lane relays the call.
            const receipt = JSON.stringify(await action.call(args, AbortSignal.any([abort.signal, extra.signal])));
            if (typeof receipt !== "string" || Buffer.byteLength(receipt) > RESULT_LIMIT) throw Error();
            return { content: [{ type: "text" as const, text: receipt }] };
          } catch {
            return { isError: true, content: [{ type: "text" as const, text: "Workspace action unavailable; do not automatically retry." }] };
          }
        }
        try {
          if (!allowed.has(request.params.name) || expiresAt <= Date.now()) throw Error();
          // Validate before authority lookup as well as within the registered gateway adapter.
          try { published.get(request.params.name)!.validateParams(args); }
          catch (error) {
            if (!(error instanceof ToolGatewayError)) throw error;
            return { isError: true, content: [{ type: "text" as const,
              text: `Invalid arguments for this tool${error.reason ? `: ${error.reason}` : ""}; check its input schema and documentation.` }] };
          }
          const result = await gateway.invoke(capability, runtime, { callId: randomUUID(),
            toolAlias: request.params.name, arguments: args }, AbortSignal.any([abort.signal, extra.signal,
              AbortSignal.timeout(Math.min(expiresAt - Date.now(), callDeadline))]));
          // Text results (e.g. documentation) go to the model as they are.
          return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: failureText(error) }] };
        }
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK's accessor declarations include undefined, unlike its own optional Transport members
      // under exactOptionalPropertyTypes. Keep this compatibility cast local to SDK wiring.
      await protocol.connect(transport as Parameters<Server["connect"]>[0]);
      abort.signal.throwIfAborted();
      await transport.handleRequest(req, res, body);
    } catch { fail(503); }
    finally { clearTimeout(bodyDeadline); if (res.writableEnded || res.destroyed) clean(); }
  });
  server.maxConnections = 64;
  return server;
}
