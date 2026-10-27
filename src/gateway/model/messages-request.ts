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
/** Anthropic Messages entry codec. Only what decides the Run's boundaries is checked: the model
 * alias, the function inventory (no provider-side tools or remote MCP servers, except the
 * provider's web search under the Run's web policy), content the provider would fetch or look up
 * (only inline images and documents, in file mode) and the output ceiling. Everything else
 * (thinking, output_config, context_management, cache_control, metadata, ...) passes through
 * unchanged, so new CLI features keep working. */
import type { MessagesCall } from "../../spi/model-upstream.js";
import { FILE_REQUEST_BYTES } from "./file-mode.js";
import { narrowDomains, NO_WEB, type WebPolicy } from "./web-access.js";

export class MessagesRequestError extends Error {
  constructor() {
    super("MODEL_MESSAGES_REQUEST_INVALID");
  }
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MessagesRequestError();
  return value as RecordValue;
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value))
    throw new MessagesRequestError();
}

/** Request fields that would let the provider reach tools or state outside the gateway. */
const FORBIDDEN_FIELDS = ["mcp_servers", "container"];
/** Header values are forwarded verbatim but must stay plain tokens. */
const VERSION = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const BETA = /^[A-Za-z0-9._-]{1,128}(,\s*[A-Za-z0-9._-]{1,128}){0,31}$/;

/** Provider web search tool versions (`web_search_20250305`, ...). */
export const WEB_SEARCH_TOOL = /^web_search_[0-9]{8}$/;
/** The provider's fixed name of its web search tool. */
export const WEB_SEARCH_NAME = "web_search";
const WEB_SEARCH_FIELDS = [
  "type",
  "name",
  "allowed_domains",
  "blocked_domains",
  "max_uses",
  "user_location",
  "cache_control"
];

/** Inline image types a file-mode request may carry (as on the Responses entry). */
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A block carrying a `source` (image, document, search result, ...): only what the CLI read,
 * inline, in file mode: base64 raster images, base64 PDFs and plain text documents. A `url`
 * source makes the provider fetch from the network on the model's behalf (a command in the
 * sandbox holding the model capability could put data into the URL), and a `file` source reads
 * provider-stored files outside the Run. Same policy as the Responses entry's data-URL images. */
function sourceBlock(block: RecordValue, files: boolean): void {
  if (!files) throw new MessagesRequestError();
  const source = object(block.source);
  if (typeof source.data !== "string") throw new MessagesRequestError();
  const inline =
    (block.type === "image" &&
      source.type === "base64" &&
      IMAGE_MEDIA_TYPES.includes(String(source.media_type))) ||
    (block.type === "document" &&
      ((source.type === "base64" && source.media_type === "application/pdf") ||
        (source.type === "text" && source.media_type === "text/plain")));
  if (!inline) throw new MessagesRequestError();
}

/** Content blocks naming a tool: only client tools from the inventory and their results, plus
 * earlier provider web searches in a Run with web access. Blocks with a source go through
 * sourceBlock, inside tool results too (`nested`: a tool result's content or the system prompt,
 * where no tool block belongs). */
function contentBlock(
  raw: unknown,
  allowed: ReadonlySet<string>,
  web: boolean,
  files: boolean,
  nested = false
): void {
  const block = object(raw);
  if (typeof block.type !== "string") throw new MessagesRequestError();
  if (Object.hasOwn(block, "source")) sourceBlock(block, files);
  if (block.type === "tool_use") {
    if (nested || typeof block.name !== "string" || !allowed.has(block.name))
      throw new MessagesRequestError();
  } else if (block.type === "tool_result") {
    // Text, or the blocks its tool produced (e.g. the image Read returned).
    if (nested) throw new MessagesRequestError();
    if (Array.isArray(block.content))
      block.content.forEach(child => contentBlock(child, allowed, web, files, true));
    else if (block.content !== undefined && typeof block.content !== "string")
      throw new MessagesRequestError();
  } else if (web && !nested && block.type === "server_tool_use") {
    if (block.name !== WEB_SEARCH_NAME) throw new MessagesRequestError();
  } else if (web && !nested && block.type === "web_search_tool_result") return;
  else if (/tool|mcp|container/.test(block.type)) throw new MessagesRequestError();
}

/** The provider web search tool under the Run's policy: as sent (`open`); with `allowed_domains`
 * narrowed to the allowlist and `blocked_domains` dropped (the provider accepts only one of
 * them) (`allowlist`); or removed (`off`, or nothing left to reach). */
function webSearchTool(
  tool: Record<string, unknown>,
  policy: WebPolicy
): Record<string, unknown>[] {
  if (Object.keys(tool).some(key => !WEB_SEARCH_FIELDS.includes(key)))
    throw new MessagesRequestError();
  if (tool.name !== WEB_SEARCH_NAME) throw new MessagesRequestError();
  for (const key of ["allowed_domains", "blocked_domains"]) {
    const list = tool[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.length > 100 || list.some(v => typeof v !== "string"))
    )
      throw new MessagesRequestError();
  }
  if (
    tool.max_uses !== undefined &&
    (!Number.isSafeInteger(tool.max_uses) || Number(tool.max_uses) < 1)
  )
    throw new MessagesRequestError();
  const { access } = policy;
  if (access.mode === "open") return [tool];
  if (access.mode === "off") return [];
  const domains = narrowDomains(tool.allowed_domains, access.domains);
  if (!domains.length) return [];
  const narrowed: Record<string, unknown> = { ...tool, allowed_domains: domains };
  delete narrowed.blocked_domains;
  return [narrowed];
}

/** `allowedFunctions` comes from trusted Run policy, never from the request's own tool list.
 * This restricts model-visible functions only; the tool gateway still authorizes every call.
 * `max_tokens` above the deployment ceiling is lowered to it. `files`: file-mode Run, whose
 * requests carry the images and documents its CLI read, inline only (larger size limit); other
 * Runs carry no source blocks at all. */
export function parseMessagesRequest(
  value: unknown,
  headers: Readonly<{ version?: string; beta?: string; betaQuery: boolean }>,
  allowedFunctions: readonly string[],
  maxOutputTokens: number,
  webPolicy: WebPolicy = NO_WEB,
  files = false
): MessagesCall {
  try {
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 16 ||
      maxOutputTokens > 1_000_000 ||
      allowedFunctions.length > 64
    )
      throw new MessagesRequestError();
    allowedFunctions.forEach(identifier);
    const web = webPolicy.access.mode !== "off";
    // Harness web tools (built on the provider's search) exist only while the Run has web access.
    const withheld = new Set(web ? [] : webPolicy.functions);
    const allowed = new Set([...allowedFunctions, ...(web ? webPolicy.functions : [])]);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > (files ? FILE_REQUEST_BYTES : 1_000_000))
      throw new MessagesRequestError();
    const body = object(JSON.parse(encoded));
    if (FORBIDDEN_FIELDS.some(field => Object.hasOwn(body, field)))
      throw new MessagesRequestError();
    identifier(body.model);
    if (body.stream !== true) throw new MessagesRequestError();
    if (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1)
      throw new MessagesRequestError();
    body.max_tokens = Math.min(Number(body.max_tokens), maxOutputTokens);
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 4096)
      throw new MessagesRequestError();
    for (const raw of body.messages) {
      const message = object(raw);
      if (Array.isArray(message.content))
        message.content.forEach(block => contentBlock(block, allowed, web, files));
      else if (typeof message.content !== "string") throw new MessagesRequestError();
    }
    // System blocks are text: the same check keeps sources and tool blocks out of them too.
    if (Array.isArray(body.system))
      body.system.forEach(block => contentBlock(block, allowed, web, files, true));
    else if (body.system !== undefined && typeof body.system !== "string")
      throw new MessagesRequestError();
    const names = new Set<string>();
    let stripped = false;
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools) || body.tools.length > allowed.size + withheld.size + 1)
        throw new MessagesRequestError();
      body.tools = body.tools.flatMap(raw => {
        const tool = object(raw);
        // Typed entries are provider-executed (code execution, remote MCP toolsets, ...): only
        // the web search, under the Run's policy.
        if (typeof tool.type === "string" && WEB_SEARCH_TOOL.test(tool.type)) {
          if (names.has(WEB_SEARCH_NAME)) throw new MessagesRequestError();
          const kept = webSearchTool(tool, webPolicy);
          if (kept.length) names.add(WEB_SEARCH_NAME);
          else stripped = true;
          return kept;
        }
        if (tool.type !== undefined && tool.type !== "custom") throw new MessagesRequestError();
        if (typeof tool.name === "string" && withheld.has(tool.name)) {
          object(tool.input_schema);
          stripped = true;
          return [];
        }
        if (typeof tool.name !== "string" || !allowed.has(tool.name) || names.has(tool.name))
          throw new MessagesRequestError();
        names.add(tool.name);
        object(tool.input_schema);
        return [tool];
      });
      // Every tool removed by policy: send none, and no choice among them (rejected upstream).
      if (stripped && !names.size) {
        delete body.tools;
        delete body.tool_choice;
      }
    }
    if (body.tool_choice !== undefined) {
      const choice = object(body.tool_choice);
      if (!["auto", "any", "none", "tool"].includes(String(choice.type)))
        throw new MessagesRequestError();
      if (choice.type === "tool") {
        const name = choice.name;
        if (typeof name !== "string") throw new MessagesRequestError();
        if (stripped && !names.has(name) && (name === WEB_SEARCH_NAME || withheld.has(name)))
          delete body.tool_choice;
        else if (!allowed.has(name) && !names.has(name)) throw new MessagesRequestError();
      }
    }
    if (
      (headers.version !== undefined && !VERSION.test(headers.version)) ||
      (headers.beta !== undefined && !BETA.test(headers.beta))
    )
      throw new MessagesRequestError();
    return Object.freeze({
      body: body as MessagesCall["body"],
      ...(headers.version !== undefined ? { version: headers.version } : {}),
      ...(headers.beta !== undefined ? { beta: headers.beta } : {}),
      betaQuery: headers.betaQuery === true
    });
  } catch {
    throw new MessagesRequestError();
  }
}
