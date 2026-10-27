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
/** Anthropic Messages upstream: the validated request goes to the operator-pinned provider with
 * the lease's key; SSE events stream back one by one, unbuffered. Events are checked only where
 * the Run's boundaries are at stake (tool identity, credentials); usage is taken from
 * message_start / message_delta. No retries, fallback provider or redirects. */
import { WEB_SEARCH_NAME, WEB_SEARCH_TOOL } from "./messages-request.js";
import { rejectSecrets, secretPrefixSuffix } from "./responses-provider.js";
import { EventFrames } from "./responses-stream.js";
import type { UpstreamSend } from "./upstream-transport.js";
import {
  ModelUpstreamRejection,
  type MessagesCall,
  type MessagesEvent,
  type MessagesResult,
  type MessagesSink,
  type MessagesUpstream,
  type ResponsesTiming
} from "../../spi/model-upstream.js";

/** How the provider key is sent. Anthropic uses `x-api-key`; some relays expect a bearer token. */
export type MessagesAuth = "x-api-key" | "bearer" | "both";

const STREAM_LIMIT = 16 * 1024 * 1024;
const EVENT_LIMIT = 65_536;
const ERROR_BODY_LIMIT = 64 * 1024;
const DEFAULT_VERSION = "2023-06-01";
/** Model-generated strings that may carry (a prefix of) a credential across deltas. */
const DELTA_TEXT = ["text", "thinking", "partial_json"] as const;

type Value = Record<string, unknown>;
interface Frame {
  readonly event: MessagesEvent;
  readonly value: Value;
}

export class MessagesProvider implements MessagesUpstream {
  private readonly endpoint: string;
  constructor(
    origin: string,
    private readonly send: UpstreamSend = fetch,
    private readonly auth: MessagesAuth = "x-api-key"
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/v1", "/v1/"].includes(url.pathname) ||
      !["x-api-key", "bearer", "both"].includes(auth)
    )
      throw Error("MODEL_PROVIDER_CONFIGURATION");
    this.endpoint = new URL("/v1/messages", url.origin).href;
  }

  /** Open a pooled connection to the provider ahead of the first call; sends no credentials. */
  warm(): void {
    this.send.warm?.(this.endpoint);
  }

  async invoke(
    call: MessagesCall,
    providerModel: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: MessagesSink,
    timing: ResponsesTiming = () => {}
  ): Promise<MessagesResult> {
    try {
      signal.throwIfAborted();
      if (
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(providerModel) ||
        !/^[\x21-\x7e]{16,4096}$/.test(secret)
      )
        throw Error();
      const request = call.body;
      const body = JSON.stringify({ ...request, model: providerModel });
      const tools = Array.isArray(request.tools) ? (request.tools as Value[]) : [];
      timing("provider-request", {
        requestBytes: Buffer.byteLength(body),
        inputItems: Array.isArray(request.messages) ? request.messages.length : 0,
        toolDefinitions: tools.length,
        reasoningEffort: String(
          (request.output_config as { effort?: unknown } | undefined)?.effort ?? "default"
        ),
        maxOutputTokens: request.max_tokens,
        shape: [
          Object.keys(request).sort().join(","),
          tools
            .map(
              tool =>
                (tool && typeof tool === "object" && (tool as { type?: unknown }).type) || "custom"
            )
            .join(","),
          call.beta ?? ""
        ].join(" | ")
      });
      // The CLI's own credential headers are never forwarded: only the lease's key.
      const response = await this.send(`${this.endpoint}${call.betaQuery ? "?beta=true" : ""}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          ...(this.auth !== "bearer" ? { "x-api-key": secret } : {}),
          ...(this.auth !== "x-api-key" ? { authorization: `Bearer ${secret}` } : {}),
          "anthropic-version": call.version ?? DEFAULT_VERSION,
          ...(call.beta ? { "anthropic-beta": call.beta } : {}),
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body
      });
      timing("provider-headers");
      const forbidden = [secret, ...forbiddenValues].filter(Boolean);
      if (response.status !== 200) throw await rejection(response, forbidden);
      if (
        !response.body ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "text/event-stream"
      ) {
        await response.body?.cancel();
        throw Error();
      }
      // Client tools the model may call; provider web search only when the gateway kept it.
      const names = new Set(
        tools.filter(tool => tool.type === undefined || tool.type === "custom").map(t => t.name)
      );
      const web = tools.some(
        tool => typeof tool.type === "string" && WEB_SEARCH_TOOL.test(tool.type)
      );
      const events: MessagesEvent[] = [];
      const suffixes = new Map<string, string>();
      const usage: Record<string, number> = {};
      let published = 0;
      let state: "initial" | "streaming" | "stopped" = "initial";
      // From the first tool call on, events wait for accounting: the CLI may run a tool as soon
      // as its block is complete.
      let toolBoundary = false;
      let firstDelta = false;
      for await (const { event, value } of readMessagesEvents(response.body, signal)) {
        rejectSecrets(value, forbidden);
        if (state === "stopped") throw Error();
        const type = event.event;
        if (type === "error") {
          // Forwarded as the stream's last event; held events are dropped.
          throw new ModelUpstreamRejection(200, event.data, undefined, true);
        }
        if (type === "message_start") {
          if (state !== "initial") throw Error();
          state = "streaming";
          const message = object(value.message);
          if (!Array.isArray(message.content)) throw Error();
          message.content.forEach(block => checkBlock(block, names, web));
          addUsage(usage, message.usage);
        } else if (type !== "ping" && state !== "streaming") throw Error();
        if (type === "content_block_start") {
          const block = object(value.content_block);
          checkBlock(block, names, web);
          toolBoundary ||= block.type === "tool_use";
        } else if (type === "content_block_delta") {
          const delta = object(value.delta);
          if (delta.type === "text_delta" && !firstDelta) {
            firstDelta = true;
            timing("provider-first-text");
          }
          // Keep possible credential prefixes private across delta boundaries.
          for (const field of DELTA_TEXT) {
            if (typeof delta[field] !== "string") continue;
            const channels = [
              `${String(value.index)}:${field}`,
              ...(field === "text" ? ["all-text"] : [])
            ];
            for (const key of channels) {
              const joined = (suffixes.get(key) ?? "") + delta[field];
              rejectSecrets(joined, forbidden);
              const suffix = secretPrefixSuffix(joined, forbidden);
              if (suffix) suffixes.set(key, suffix);
              else suffixes.delete(key);
            }
          }
        } else if (type === "message_delta") addUsage(usage, value.usage);
        else if (type === "message_stop") state = "stopped";
        events.push(event);
        // The terminal event waits for accounting.
        if (publish && state !== "stopped" && suffixes.size === 0 && !toolBoundary) {
          while (published < events.length) {
            signal.throwIfAborted();
            await publish(events[published++]!);
          }
        }
      }
      signal.throwIfAborted();
      timing("provider-ended");
      const input =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const output = usage.output_tokens ?? 0;
      if (state !== "stopped" || output > request.max_tokens) throw Error();
      const webSearches = usage.web_search_requests ?? 0;
      return Object.freeze({
        events: Object.freeze(events),
        usage: Object.freeze({
          inputTokens: input,
          outputTokens: output,
          ...(webSearches ? { webSearches } : {})
        })
      });
    } catch (error) {
      if (error instanceof ModelUpstreamRejection) throw error;
      throw Error("MODEL_MESSAGES_PROVIDER_UNAVAILABLE");
    }
  }
}

function object(value: unknown): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
  return value as Value;
}

/** Provider-side tool blocks (server_tool_use, *_tool_result, mcp_*, container_*) must not enter
 * the CLI stream, except the provider's web search when the request kept it (`web`); a client
 * tool call must name a function the request offered. */
function checkBlock(raw: unknown, names: ReadonlySet<unknown>, web = false): void {
  const block = object(raw);
  if (typeof block.type !== "string") throw Error();
  if (block.type === "tool_use") {
    if (!names.has(block.name) || typeof block.id !== "string") throw Error();
  } else if (web && block.type === "server_tool_use") {
    if (block.name !== WEB_SEARCH_NAME || typeof block.id !== "string") throw Error();
  } else if (web && block.type === "web_search_tool_result") return;
  else if (/tool|mcp|container/.test(block.type)) throw Error();
}

/** Usage counters are cumulative; later events overwrite earlier values. Provider-executed web
 * searches are reported as `server_tool_use.web_search_requests`. */
function addUsage(target: Record<string, number>, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const usage = object(raw);
  const server = usage.server_tool_use;
  if (server && typeof server === "object" && !Array.isArray(server)) {
    const searches = (server as Value).web_search_requests;
    if (Number.isSafeInteger(searches) && Number(searches) >= 0)
      target.web_search_requests = Number(searches);
  }
  for (const key of [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens"
  ]) {
    const value = usage[key];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error();
    target[key] = Number(value);
  }
}

/** HTTP error for the CLI: status, a bounded JSON body without credentials, and the retry hint.
 * Anything else becomes a generic error of the same status. */
async function rejection(
  response: Response,
  forbidden: readonly string[]
): Promise<ModelUpstreamRejection> {
  const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
  let body = "";
  try {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = reader ? await reader.read() : { done: true as const, value: undefined };
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ERROR_BODY_LIMIT) {
        await reader?.cancel();
        throw Error();
      }
      chunks.push(next.value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const parsed = object(JSON.parse(text));
    rejectSecrets(parsed, forbidden);
    object(parsed.error);
    body = text;
  } catch {
    body = JSON.stringify({
      type: "error",
      error: {
        type: status >= 500 ? "api_error" : "invalid_request_error",
        message: "Upstream error"
      }
    });
  }
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  return new ModelUpstreamRejection(
    status,
    body,
    retryAfter && /^[0-9]{1,6}$/.test(retryAfter) ? retryAfter : undefined
  );
}

/** Bounded SSE decoding. The event name comes from the JSON `type` (some relays omit `event:`
 * lines); the data line is kept verbatim for forwarding. */
async function* readMessagesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frames = new EventFrames();
  let size = 0;
  let count = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > STREAM_LIMIT) throw Error();
      for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
        if (frame.data === "[DONE]") continue;
        if (++count > EVENT_LIMIT) throw Error();
        const value = object(JSON.parse(frame.data));
        if (
          typeof value.type !== "string" ||
          !/^[a-z][a-z_]{0,63}$/.test(value.type) ||
          (frame.name && frame.name !== value.type)
        )
          throw Error();
        yield { event: Object.freeze({ event: value.type, data: frame.data }), value };
      }
    }
    decoder.decode(); // Reject an incomplete trailing UTF-8 code point.
    frames.finish();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
