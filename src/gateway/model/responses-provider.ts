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
import {
  responsesFunctionInventory,
  responsesFunctionKey,
  type ManagedResponsesRequest
} from "./responses-request.js";
import { readResponsesEvents, type ResponsesEvent } from "./responses-stream.js";
import { upstreamEndpoint } from "./upstream-endpoint.js";
import type { UpstreamSend } from "./upstream-transport.js";
import type {
  ModelUpstream,
  ResponsesRequestMetrics,
  ResponsesResult,
  ResponsesSink,
  ResponsesTiming
} from "../../spi/model-upstream.js";

export type { ResponsesRequestMetrics, ResponsesResult, ResponsesSink, ResponsesTiming };

/** Operator-pinned HTTPS provider. No retries, fallback provider, remote tool execution or redirects.
 * Text is validated incrementally. Tool execution and terminal success remain behind accounting.
 */
/** Upstream events that carry no model output and are dropped rather than rejected. */
const IGNORED_EVENTS: ReadonlySet<string> = new Set(["response.metadata"]);

export class ResponsesProvider implements ModelUpstream {
  private readonly endpoint: string;
  constructor(
    origin: string,
    private readonly send: UpstreamSend = fetch
  ) {
    this.endpoint = upstreamEndpoint(origin, "responses");
  }

  /** Open a pooled connection to the provider ahead of the first call; sends no credentials. */
  warm(): void {
    this.send.warm?.(this.endpoint);
  }

  async invoke(
    request: ManagedResponsesRequest,
    providerModel: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: ResponsesSink,
    timing: ResponsesTiming = () => {}
  ): Promise<ResponsesResult> {
    try {
      signal.throwIfAborted();
      if (
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(providerModel) ||
        !/^[\x21-\x7e]{16,4096}$/.test(secret)
      )
        throw Error();
      const body = JSON.stringify({ ...request, model: providerModel, stream: true, store: false });
      timing("provider-request", {
        requestBytes: Buffer.byteLength(body),
        inputItems: Array.isArray(request.input) ? request.input.length : 1,
        toolDefinitions: Array.isArray(request.tools) ? request.tools.length : 0,
        reasoningEffort: String(
          (request.reasoning as { effort?: string } | undefined)?.effort ?? "default"
        ),
        maxOutputTokens: request.max_output_tokens
      });
      const response = await this.send(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body
      });
      timing("provider-headers");
      if (
        response.status !== 200 ||
        !response.body ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "text/event-stream"
      ) {
        await response.body?.cancel();
        throw Error();
      }
      const events: ResponsesEvent[] = [];
      let terminal: ResponsesEvent | undefined;
      const functions = responsesFunctionInventory(request.tools);
      // Provider-executed web search is admitted only when the gateway left the tool in place.
      const web =
        Array.isArray(request.tools) &&
        (request.tools as Record<string, unknown>[]).some(isWebSearchTool);
      const forbidden = [secret, ...forbiddenValues].filter(Boolean);
      const suffixes = new Map<string, string>();
      let published = 0;
      let toolBoundary = false;
      let firstDelta = false;
      for await (const event of readResponsesEvents(response.body, signal)) {
        // Provider-side bookkeeping (e.g. routing metadata from relays); never forwarded to the CLI.
        if (IGNORED_EVENTS.has(event.type)) continue;
        if (event.type === "response.output_text.delta" && !firstDelta) {
          firstDelta = true;
          timing("provider-first-text");
        }
        rejectSecrets(event, forbidden);
        validateEvent(event, functions, web);
        events.push(event);
        if (event.type === "response.completed") {
          terminal = event;
          continue;
        }
        // Keep possible credential prefixes private across delta boundaries. Usually this holds
        // no events; unlike a fixed key-length buffer, short ordinary replies stream immediately.
        if (typeof event.delta === "string") {
          const channel = JSON.stringify([
            event.type,
            event.item_id,
            event.output_index,
            event.content_index,
            event.summary_index
          ]);
          const channels =
            event.type === "response.output_text.delta" ? [channel, "all-text"] : [channel];
          for (const key of channels) {
            const joined = (suffixes.get(key) ?? "") + event.delta;
            rejectSecrets(joined, forbidden);
            const suffix = secretPrefixSuffix(joined, forbidden);
            if (suffix) suffixes.set(key, suffix);
            else suffixes.delete(key);
          }
        }
        const item = event.item as Record<string, unknown> | undefined;
        toolBoundary ||=
          item?.type === "function_call" ||
          event.type.startsWith("response.function_call_arguments.");
        if (publish && suffixes.size === 0 && !toolBoundary) {
          while (published < events.length) {
            signal.throwIfAborted();
            await publish(events[published++]!);
          }
        }
      }
      signal.throwIfAborted();
      timing("provider-ended");
      const completed = terminal?.response;
      if (!completed || typeof completed !== "object" || Array.isArray(completed)) throw Error();
      const result = completed as Record<string, unknown>;
      if (
        result.status !== "completed" ||
        result.model !== providerModel ||
        typeof result.id !== "string" ||
        !Array.isArray(result.output) ||
        result.output.length > 256
      )
        throw Error();
      const usage = result.usage as Record<string, unknown> | undefined;
      if (
        !usage ||
        !Number.isSafeInteger(usage.input_tokens) ||
        Number(usage.input_tokens) < 0 ||
        !Number.isSafeInteger(usage.output_tokens) ||
        Number(usage.output_tokens) < 0 ||
        Number(usage.output_tokens) > request.max_output_tokens
      )
        throw Error();
      const text = events
        .filter(e => e.type === "response.output_text.delta")
        .map(e => (typeof e.delta === "string" ? e.delta : ""))
        .join("");
      rejectSecrets(text, [secret, ...forbiddenValues]);
      // Web searches are billed per call: count the provider's search items for diagnostics.
      const webSearches = (result.output as Record<string, unknown>[]).filter(
        item => item?.type === "web_search_call"
      ).length;
      return Object.freeze({
        events: Object.freeze(events),
        usage: Object.freeze({
          inputTokens: Number(usage.input_tokens),
          outputTokens: Number(usage.output_tokens),
          ...(webSearches ? { webSearches } : {})
        })
      });
    } catch {
      throw Error("MODEL_RESPONSES_PROVIDER_UNAVAILABLE");
    }
  }
}

/** Longest suffix of `text` that begins one of `secrets`: held back until the next delta. */
export function secretPrefixSuffix(text: string, secrets: readonly string[]): string {
  let longest = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > longest; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest ? text.slice(-longest) : "";
}

function isWebSearchTool(tool: Record<string, unknown> | undefined): boolean {
  return typeof tool?.type === "string" && /^web_search(_preview)?(_[0-9_]+)?$/.test(tool.type);
}

/** Web search progress and citations; only in a request that kept the web search tool. */
const WEB_EVENT = /^response\.(web_search_call\.[a-z_]+|output_text\.annotation\.added)$/;

/** Provider-hosted tools must not enter a CLI stream through intermediate item events either;
 * web search only when `web` (the request carries the gateway-admitted web search tool). */
function validateEvent(event: ResponsesEvent, functions: ReadonlySet<string>, web = false): void {
  if (
    !/^(response\.(created|in_progress|completed|output_item\.(added|done)|content_part\.(added|done)|output_text\.(delta|done)|refusal\.(delta|done)|function_call_arguments\.(delta|done)|reasoning_summary_part\.(added|done)|reasoning_summary_text\.(delta|done)|reasoning_text\.(delta|done)))$/.test(
      event.type
    ) &&
    !(web && WEB_EVENT.test(event.type))
  )
    throw Error();
  if (event.item !== undefined) validateItem(event.item, functions, web);
  if (event.response && typeof event.response === "object") {
    const output = (event.response as Record<string, unknown>).output;
    if (output !== undefined) {
      if (!Array.isArray(output) || output.length > 256) throw Error();
      output.forEach(item => validateItem(item, functions, web));
    }
  }
}

function validateItem(value: unknown, functions: ReadonlySet<string>, web = false): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
  const item = value as Record<string, unknown>;
  if (item.type === "function_call") {
    if (
      typeof item.name !== "string" ||
      !functions.has(responsesFunctionKey(item.name, item.namespace)) ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    )
      throw Error();
  } else if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) throw Error();
    for (const part of item.content) {
      if (!part || typeof part !== "object" || !["output_text", "refusal"].includes(part.type))
        throw Error();
      if (typeof (part.type === "output_text" ? part.text : part.refusal) !== "string")
        throw Error();
    }
  } else if (item.type === "web_search_call") {
    if (!web || typeof item.id !== "string") throw Error();
  } else if (item.type !== "reasoning") throw Error();
}

export function rejectSecrets(value: unknown, secrets: readonly string[], depth = 0): void {
  if (depth > 32) throw Error();
  if (typeof value === "string") {
    if (secrets.some(secret => secret && value.includes(secret))) throw Error();
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      rejectSecrets(key, secrets, depth + 1);
      rejectSecrets(child, secrets, depth + 1);
    }
  }
}
