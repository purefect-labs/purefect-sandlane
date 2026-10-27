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
/** Stateless, text/function-only Responses subset for the managed CLI lane.
 * Provider-side tools and stored conversations would bypass the gateway's tool/user boundaries;
 * the one exception is the provider's web search, admitted per the Run's web policy.
 */
import type { ManagedResponsesRequest } from "../../spi/model-upstream.js";
import { FILE_REQUEST_BYTES, IMAGE_DATA_URL } from "./file-mode.js";
import { narrowDomains, NO_WEB, type WebPolicy } from "./web-access.js";

export type { ManagedResponsesRequest };

export class ResponsesRequestError extends Error {
  constructor() {
    super("MODEL_RESPONSES_REQUEST_INVALID");
  }
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ResponsesRequestError();
  return value as RecordValue;
}
function fields(value: RecordValue, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ResponsesRequestError();
}
function text(value: unknown, max = 128000): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || /[\uD800-\uDFFF]/u.test(value))
    throw new ResponsesRequestError();
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value))
    throw new ResponsesRequestError();
}
function oneOf(value: unknown, values: readonly unknown[]): void {
  if (!values.includes(value)) throw new ResponsesRequestError();
}

/** Preserve namespace identity; a flat function with a similar name is not the same tool. */
export function responsesFunctionKey(name: unknown, namespace?: unknown): string {
  identifier(name);
  if (namespace !== undefined) identifier(namespace);
  return JSON.stringify([namespace ?? null, name]);
}

export function responsesFunctionInventory(tools: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const tool of (tools ?? []) as RecordValue[]) {
    if (tool.type === "namespace") {
      for (const child of tool.tools as RecordValue[])
        keys.add(responsesFunctionKey(child.name, tool.name));
    } else if (tool.type === undefined || tool.type === "function")
      keys.add(responsesFunctionKey(tool.name));
  }
  return keys;
}
function freeze(value: unknown, maxString: number, depth = 0): void {
  if (depth > 24) throw new ResponsesRequestError();
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child, maxString, depth + 1);
    Object.freeze(value);
  } else if (typeof value === "string") text(value, maxString);
}

/** An inline image the CLI viewed (file mode only): a data URL, never a remote one. */
function inputImage(part: RecordValue): void {
  fields(part, ["type", "image_url", "detail"]);
  oneOf(part.type, ["input_image"]);
  if (
    typeof part.image_url !== "string" ||
    part.image_url.length > FILE_REQUEST_BYTES ||
    !IMAGE_DATA_URL.test(part.image_url)
  )
    throw new ResponsesRequestError();
  if (part.detail !== undefined) oneOf(part.detail, ["auto", "low", "high", "original"]);
}

/** Citation of a web search result in model text (only in Runs with web access). */
function annotation(raw: unknown): void {
  const value = object(raw);
  fields(value, ["type", "start_index", "end_index", "url", "title"]);
  oneOf(value.type, ["url_citation"]);
  for (const index of [value.start_index, value.end_index])
    if (!Number.isSafeInteger(index) || Number(index) < 0) throw new ResponsesRequestError();
  text(value.url, 4096);
  if (value.title !== undefined) text(value.title, 4096);
}

function message(value: RecordValue, web: boolean, files: boolean): void {
  fields(value, ["type", "role", "content", "id", "status", "phase"]);
  oneOf(value.role, ["system", "developer", "user", "assistant"]);
  if (value.type !== undefined) oneOf(value.type, ["message"]);
  if (value.id !== undefined) identifier(value.id);
  if (value.status !== undefined) oneOf(value.status, ["completed"]);
  if (value.phase !== undefined) oneOf(value.phase, ["commentary", "final_answer"]);
  if (typeof value.content === "string") {
    text(value.content);
    return;
  }
  if (!Array.isArray(value.content) || value.content.length < 1 || value.content.length > 128)
    throw new ResponsesRequestError();
  for (const part of value.content) {
    const p = object(part);
    if (files && value.role === "user" && p.type === "input_image") {
      inputImage(p);
      continue;
    }
    fields(p, ["type", "text", "annotations"]);
    oneOf(p.type, ["input_text", "output_text"]);
    text(p.text);
    if (p.annotations !== undefined) {
      if (!Array.isArray(p.annotations) || (!web && p.annotations.length))
        throw new ResponsesRequestError();
      if (p.annotations.length > 128) throw new ResponsesRequestError();
      p.annotations.forEach(annotation);
    }
  }
}

/** MCP tool namespaces (`mcp__<server>`) named by the allowed `namespace.function` entries. */
function namespacesOf(allowed: ReadonlySet<string>): string[] {
  return [...allowed]
    .filter(name => name.startsWith("mcp__") && name.includes("."))
    .map(name => name.slice(0, name.indexOf(".")));
}

function item(raw: unknown, allowed: ReadonlySet<string>, web: boolean, files: boolean): void {
  const value = object(raw);
  if (value.type === undefined || value.type === "message") {
    message(value, web, files);
    return;
  }
  // An earlier provider-executed search of this Run, replayed as history (stateless requests).
  if (value.type === "web_search_call" && web) {
    fields(value, ["type", "id", "status", "action"]);
    identifier(value.id);
    oneOf(value.status, ["in_progress", "searching", "completed", "failed", "incomplete"]);
    if (value.action !== undefined) {
      const action = object(value.action);
      oneOf(action.type, ["search", "open_page", "find_in_page", "find", "other"]);
    }
    return;
  }
  if (value.type === "function_call" || value.type === "function_call_output") {
    fields(
      value,
      value.type === "function_call"
        ? ["type", "id", "call_id", "name", "namespace", "arguments", "status"]
        : ["type", "id", "call_id", "output", "status"]
    );
    identifier(value.call_id);
    if (value.id !== undefined) identifier(value.id);
    if (value.status !== undefined) oneOf(value.status, ["completed"]);
    if (value.type === "function_call") {
      const name = value.namespace === undefined ? value.name : `${value.namespace}.${value.name}`;
      if (value.namespace !== undefined) oneOf(value.namespace, namespacesOf(allowed));
      identifier(value.name);
      if (typeof name !== "string" || !allowed.has(name)) throw new ResponsesRequestError();
      text(value.arguments);
    } else if (Array.isArray(value.output)) {
      if (value.output.length < 1 || value.output.length > 128) throw new ResponsesRequestError();
      for (const rawPart of value.output) {
        const part = object(rawPart);
        if (files && part.type === "input_image") {
          inputImage(part);
          continue;
        }
        fields(part, ["type", "text"]);
        oneOf(part.type, ["input_text"]);
        text(part.text);
      }
    } else text(value.output);
    return;
  }
  if (value.type === "reasoning") {
    fields(value, ["type", "id", "summary", "encrypted_content"]);
    identifier(value.id);
    text(value.encrypted_content);
    if (!Array.isArray(value.summary) || value.summary.length > 128)
      throw new ResponsesRequestError();
    for (const rawPart of value.summary) {
      const part = object(rawPart);
      fields(part, ["type", "text"]);
      oneOf(part.type, ["summary_text"]);
      text(part.text);
    }
    return;
  }
  throw new ResponsesRequestError();
}

/** Provider web search tool types. The preview types take no domain filter. */
const WEB_SEARCH_TOOLS: readonly unknown[] = [
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11"
];

/** The web search tool under the Run's policy: as sent (`open`), with its domain filter narrowed
 * to the allowlist (`allowlist`), or removed (`off`, or nothing left to reach). Removal is
 * silent: the model then simply has no web search. */
function webSearchTool(tool: RecordValue, policy: WebPolicy): RecordValue[] {
  fields(tool, ["type", "external_web_access", "filters", "search_context_size", "user_location"]);
  if (tool.external_web_access !== undefined) oneOf(tool.external_web_access, [true, false]);
  if (tool.search_context_size !== undefined)
    oneOf(tool.search_context_size, ["low", "medium", "high"]);
  if (tool.user_location !== undefined) object(tool.user_location);
  const filters = tool.filters === undefined ? undefined : object(tool.filters);
  if (filters) fields(filters, ["allowed_domains"]);
  const { access } = policy;
  if (access.mode === "open") return [tool];
  if (access.mode === "off" || String(tool.type).startsWith("web_search_preview")) return [];
  const domains = narrowDomains(filters?.allowed_domains, access.domains);
  return domains.length ? [{ ...tool, filters: { allowed_domains: domains } }] : [];
}

/** allowedFunctions comes from trusted Run policy, never from the request's own tool list.
 * This restricts model-visible functions only; Tool Gateway must still authorize every actual call.
 * `files`: file-mode Run; its requests may carry the images its CLI viewed (inline data URLs in
 * user messages and tool outputs) and are allowed to be larger.
 */
export function parseResponsesRequest(
  value: unknown,
  allowedFunctions: readonly string[],
  defaultMaxOutputTokens: number,
  webPolicy: WebPolicy = NO_WEB,
  files = false
): ManagedResponsesRequest {
  try {
    if (
      !Number.isSafeInteger(defaultMaxOutputTokens) ||
      defaultMaxOutputTokens < 16 ||
      defaultMaxOutputTokens > 1000000 ||
      allowedFunctions.length > 64
    )
      throw new ResponsesRequestError();
    allowedFunctions.forEach(identifier);
    const allowed = new Set(allowedFunctions);
    const web = webPolicy.access.mode !== "off";
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > (files ? FILE_REQUEST_BYTES : 256000))
      throw new ResponsesRequestError();
    const request = object(JSON.parse(encoded));
    fields(request, [
      "model",
      "input",
      "instructions",
      "stream",
      "store",
      "max_output_tokens",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "include",
      "text",
      "prompt_cache_key",
      "client_metadata"
    ]);
    // Client hints are not authority and must not choose shared provider cache scope
    // or leak CLI environment metadata. Validate bounds, then omit upstream.
    if (request.prompt_cache_key !== undefined) text(request.prompt_cache_key, 256);
    if (request.client_metadata !== undefined) {
      const metadata = object(request.client_metadata);
      if (Object.keys(metadata).length > 32) throw new ResponsesRequestError();
      for (const [key, value] of Object.entries(metadata)) {
        text(key, 128);
        text(value, 2048);
      }
    }
    delete request.prompt_cache_key;
    delete request.client_metadata;
    identifier(request.model);
    oneOf(request.stream, [true]);
    if (request.store !== undefined) oneOf(request.store, [false]);
    request.store = false;
    request.max_output_tokens ??= defaultMaxOutputTokens;
    if (
      !Number.isSafeInteger(request.max_output_tokens) ||
      Number(request.max_output_tokens) < 16 ||
      Number(request.max_output_tokens) > defaultMaxOutputTokens
    )
      throw new ResponsesRequestError();
    if (request.instructions !== undefined) text(request.instructions);
    if (typeof request.input === "string") text(request.input);
    else {
      if (!Array.isArray(request.input) || request.input.length < 1 || request.input.length > 512)
        throw new ResponsesRequestError();
      request.input.forEach(entry => item(entry, allowed, web, files));
    }
    if (request.tools !== undefined) {
      if (!Array.isArray(request.tools) || request.tools.length > 68)
        throw new ResponsesRequestError();
      const names = new Set();
      const namespaces = new Set();
      const validateFunction = (raw: unknown, namespace?: string) => {
        const tool = object(raw);
        fields(tool, ["type", "name", "description", "parameters", "strict"]);
        oneOf(tool.type, ["function"]);
        identifier(tool.name);
        const policyName = namespace ? `${namespace}.${tool.name}` : tool.name;
        if (!allowed.has(policyName) || names.has(policyName)) throw new ResponsesRequestError();
        names.add(policyName);
        if (tool.description !== undefined) text(tool.description);
        if (tool.strict !== undefined) oneOf(tool.strict, [true, false]);
        object(tool.parameters);
      };
      const allowedNamespaces = namespacesOf(allowed);
      const native = request.tools.some(
        raw =>
          object(raw).type === "namespace" && allowedNamespaces.includes(String(object(raw).name))
      );
      // These CLI-local helpers cannot execute in the unattended MCP-only lane.
      // Remove their definitions; any historical/provider call to them still fails validation.
      const hidden = new Set([
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
        "request_user_input"
      ]);
      request.tools = request.tools.flatMap(raw => {
        const tool = object(raw);
        if (typeof tool.type === "string" && WEB_SEARCH_TOOLS.includes(tool.type))
          return webSearchTool(tool, webPolicy);
        if (native && tool.type === "function" && hidden.has(String(tool.name))) {
          fields(tool, ["type", "name", "description", "parameters", "strict"]);
          return [];
        }
        if (tool.type === "namespace") {
          fields(tool, ["type", "name", "description", "tools"]);
          oneOf(tool.name, allowedNamespaces);
          if (namespaces.has(tool.name)) throw new ResponsesRequestError();
          namespaces.add(tool.name);
          if (tool.description !== undefined) text(tool.description);
          if (!Array.isArray(tool.tools) || !tool.tools.length || tool.tools.length > 64)
            throw new ResponsesRequestError();
          for (const child of tool.tools) validateFunction(child, String(tool.name));
        } else validateFunction(tool);
        return [tool];
      });
      if (names.size > allowed.size) throw new ResponsesRequestError();
    }
    if (request.tool_choice !== undefined) oneOf(request.tool_choice, ["auto", "none", "required"]);
    if (request.parallel_tool_calls !== undefined)
      oneOf(request.parallel_tool_calls, [true, false]);
    const includes = [
      "reasoning.encrypted_content",
      ...(web ? ["web_search_call.action.sources", "web_search_call.results"] : [])
    ];
    if (
      request.include !== undefined &&
      (!Array.isArray(request.include) ||
        request.include.length > includes.length ||
        new Set(request.include).size !== request.include.length ||
        request.include.some(value => !includes.includes(value)))
    )
      throw new ResponsesRequestError();
    if (request.reasoning !== undefined) {
      const reasoning = object(request.reasoning);
      fields(reasoning, ["effort", "summary"]);
      if (reasoning.effort !== undefined)
        oneOf(reasoning.effort, ["none", "minimal", "low", "medium", "high", "xhigh"]);
      if (reasoning.summary !== undefined)
        oneOf(reasoning.summary, ["auto", "concise", "detailed"]);
    }
    if (request.text !== undefined) {
      const output = object(request.text);
      fields(output, ["format", "verbosity"]);
      if (output.verbosity !== undefined) oneOf(output.verbosity, ["low", "medium", "high"]);
      if (output.format !== undefined) {
        const format = object(output.format);
        fields(format, ["type"]);
        oneOf(format.type, ["text"]);
      }
    }
    freeze(request, files ? FILE_REQUEST_BYTES : 128000);
    return request as ManagedResponsesRequest;
  } catch {
    throw new ResponsesRequestError();
  }
}
