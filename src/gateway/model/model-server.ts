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
/** HTTPS model gateway: one listener, one entry per model wire (`/v1/responses` for Codex,
 * `/v1/messages` for Claude Code). A Run's capability only works on the entry of its own wire. */
import https, { type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ModelGatewayError, type ModelGateway, type RuntimeBinding } from "./gateway.js";
import type { ResponsesEvent } from "./responses-stream.js";
import type { ResponsesRequestMetrics } from "./responses-provider.js";
import { FILE_REQUEST_BYTES } from "./file-mode.js";
import { webPolicyOf, type WebAccessPolicy } from "./web-access.js";
import {
  ModelUpstreamRejection,
  type MessagesEvent,
  type ModelWire
} from "../../spi/model-upstream.js";

export interface ModelRunBinding {
  readonly runtime: Readonly<RuntimeBinding>;
  readonly expiresAt: number;
  /** Model API of the Run; requests on another entry are refused. */
  readonly wire: ModelWire;
  readonly functions: readonly string[];
  readonly maxOutputTokens: number;
  /** Web access of the Run (absent or malformed = none) and the Harness's own web tools. */
  readonly webAccess?: WebAccessPolicy;
  readonly webFunctions?: readonly string[];
  /** File-mode Run: `functions` already include the Harness's file tools; requests may be up to
   * FILE_REQUEST_BYTES and carry inline images. */
  readonly fileTools?: boolean;
}

/** Fresh Engine lookup of this MODEL capability. Never resolve identity from a request body,
 * a user header or a shared provider key; reserve/dispatch still recheck current permission.
 */
export type ModelRunLookup = (
  capability: string,
  signal: AbortSignal
) => Promise<ModelRunBinding | null>;

interface Route {
  readonly wire: ModelWire;
  /** Messages only: the SDK's `?beta=true` endpoint form, forwarded upstream as such. */
  readonly betaQuery: boolean;
  readonly bodyLimit: number;
}

/** Exact request targets. Anything else, e.g. Messages `count_tokens` (the CLI falls back to
 * estimates), is 404. */
const ROUTES: Readonly<Record<string, Route>> = Object.freeze({
  "/v1/responses": { wire: "responses", betaQuery: false, bodyLimit: 256_000 },
  // Messages requests carry the whole conversation, including tool results.
  "/v1/messages": { wire: "anthropic-messages", betaQuery: false, bodyLimit: 1_000_000 },
  "/v1/messages?beta=true": { wire: "anthropic-messages", betaQuery: true, bodyLimit: 1_000_000 }
});
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

/** Anthropic error types by HTTP status, so the CLI applies its normal handling. */
function anthropicErrorType(status: number): string {
  const types: Record<number, string> = {
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error"
  };
  return types[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
}

function sse(res: ServerResponse): void {
  if (!res.headersSent)
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
      connection: "close"
    });
}

/** The CLI's capability: a Bearer token, or for Messages also `x-api-key` (the Anthropic SDK's
 * API key header). Several sources must agree. */
function capabilityOf(req: IncomingMessage, wire: ModelWire): string | undefined {
  const count = (name: string) =>
    req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length;
  const values: string[] = [];
  if (count("authorization") > 1 || count("x-api-key") > 1) return undefined;
  const bearer = req.headers.authorization;
  if (bearer !== undefined) {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)) return undefined;
    values.push(bearer.slice(7));
  }
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && wire === "anthropic-messages") values.push(key);
  else if (key !== undefined) return undefined;
  return values.length && values.every(v => v === values[0] && CAPABILITY.test(v))
    ? values[0]
    : undefined;
}

export function createModelServer(
  tls: ServerOptions,
  hostname: string,
  gateway: Pick<ModelGateway, "respond" | "messages">,
  lookup: ModelRunLookup,
  reportTiming: (
    value: {
      callId: string;
      phase: string;
      elapsedMs: number;
      at: string;
      /** Fixed error code of a failed call. */
      error?: string;
    } & Partial<ResponsesRequestMetrics>
  ) => void = () => {},
  /** Concurrent requests and per-request ceiling; keep in line with the ModelGateway settings. */
  limits: { readonly maxActive: number; readonly timeoutMs: number } = {
    maxActive: 32,
    timeoutMs: 120_000
  }
): https.Server {
  if (!tls.key || !tls.cert || !/^[A-Za-z0-9.-]+$/.test(hostname))
    throw Error("MODEL_TLS_CONFIGURATION");
  const { maxActive, timeoutMs } = limits;
  if (
    !Number.isSafeInteger(maxActive) ||
    maxActive < 1 ||
    maxActive > 64 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 1_800_000
  )
    throw Error("MODEL_SERVER_LIMITS");
  let active = 0;
  const server = https.createServer(
    {
      ...tls,
      minVersion: "TLSv1.2",
      handshakeTimeout: 5000,
      headersTimeout: 5000,
      requestTimeout: 10000,
      maxHeaderSize: 8192
    },
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      const route = Object.hasOwn(ROUTES, req.url ?? "") ? ROUTES[req.url!] : undefined;
      // Errors on the Messages paths (including unsupported ones) use the Anthropic error form.
      const messages = route
        ? route.wire === "anthropic-messages"
        : (req.url ?? "").startsWith("/v1/messages");
      const fail = (status: number) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
          if (messages) {
            // Mid-stream: end with an error event the CLI understands, not a reset.
            res.end(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "MODEL_STREAM_FAILED" } })}\n\n`
            );
          } else res.destroy();
          return;
        }
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end(
          JSON.stringify(
            messages
              ? {
                  type: "error",
                  error: { type: anthropicErrorType(status), message: "MODEL_REQUEST_REJECTED" }
                }
              : { error: { message: "MODEL_REQUEST_REJECTED", type: "invalid_request_error" } }
          )
        );
      };
      const count = (name: string) =>
        req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length;
      if (
        count("host") !== 1 ||
        req.headers.host?.split(":")[0]?.toLowerCase() !== hostname.toLowerCase() ||
        req.headers.origin !== undefined
      ) {
        fail(403);
        return;
      }
      if (!route) {
        fail(404);
        return;
      }
      if (req.method !== "POST") {
        fail(405);
        return;
      }
      const capability = capabilityOf(req, route.wire);
      if (!capability) {
        fail(401);
        return;
      }
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") ||
        req.headers["content-encoding"] ||
        count("anthropic-version") > 1 ||
        count("anthropic-beta") > 1
      ) {
        fail(415);
        return;
      }
      if (active >= maxActive) {
        fail(429);
        return;
      }
      active++;
      const callId = randomUUID();
      const startedAt = performance.now();
      const timing = (phase: string, metrics?: ResponsesRequestMetrics, error?: string) => {
        try {
          reportTiming({
            ...metrics,
            ...(error ? { error } : {}),
            callId,
            phase,
            at: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - startedAt)
          });
        } catch {
          /* Diagnostics must not alter execution or accounting. */
        }
      };
      const abort = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once("close", disconnected);
      const deadline = setTimeout(() => {
        abort.abort();
        fail(504);
      }, timeoutMs);
      const bodyDeadline = setTimeout(() => {
        abort.abort();
        fail(408);
        req.destroy();
      }, 5000);
      let expiry: ReturnType<typeof setTimeout> | undefined;
      try {
        const binding = await abortable(lookup(capability, abort.signal), abort.signal);
        timing("binding-checked");
        if (
          !binding ||
          binding.wire !== route.wire ||
          !Number.isSafeInteger(binding.expiresAt) ||
          binding.expiresAt <= Date.now() ||
          !binding.runtime ||
          ![binding.runtime.runtimeId, binding.runtime.allocationId].every(
            v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v)
          ) ||
          !Array.isArray(binding.functions) ||
          binding.functions.length > 64 ||
          !Number.isSafeInteger(binding.maxOutputTokens) ||
          binding.maxOutputTokens < 16 ||
          binding.maxOutputTokens > 1000000
        ) {
          fail(401);
          return;
        }
        const runtime = Object.freeze({ ...binding.runtime });
        const files = binding.fileTools === true;
        const policy = Object.freeze({
          functions: Object.freeze([...binding.functions]),
          maxOutputTokens: binding.maxOutputTokens,
          web: webPolicyOf(binding.webAccess, binding.webFunctions ?? []),
          ...(files ? { files: true } : {})
        });
        const bodyLimit = files ? Math.max(route.bodyLimit, FILE_REQUEST_BYTES) : route.bodyLimit;
        expiry = setTimeout(
          () => abort.abort(),
          Math.min(timeoutMs, binding.expiresAt - Date.now())
        );
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > bodyLimit) {
            fail(413);
            return;
          }
          chunks.push(bytes);
        }
        clearTimeout(bodyDeadline);
        let input: unknown;
        try {
          input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
          );
        } catch {
          fail(400);
          return;
        }
        abort.signal.throwIfAborted();
        let first = true;
        let firstText = false;
        const write = async (frame: string) => {
          if (!res.write(frame)) await once(res, "drain", { signal: abort.signal });
        };
        if (!messages) {
          let lastPublished = -1;
          const publish = async (event: ResponsesEvent) => {
            abort.signal.throwIfAborted();
            if (lastPublished === -1) timing("first-event");
            if (event.type === "response.output_text.delta" && !firstText) {
              firstText = true;
              timing("first-text");
            }
            sse(res);
            await write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            lastPublished = event.sequence_number;
          };
          const result = await abortable(
            gateway.respond(
              capability,
              runtime,
              callId,
              input,
              policy,
              abort.signal,
              publish,
              timing
            ),
            abort.signal
          );
          abort.signal.throwIfAborted();
          for (const event of result.events) {
            if (event.sequence_number > lastPublished) await publish(event);
          }
        } else {
          // Events are forwarded verbatim and in order; the provider publishes a prefix, the
          // rest (at least the terminal event) follows accounting.
          let published = 0;
          const publish = async (event: MessagesEvent) => {
            abort.signal.throwIfAborted();
            if (first) {
              first = false;
              timing("first-event");
            }
            if (
              !firstText &&
              event.event === "content_block_delta" &&
              event.data.includes('"text_delta"')
            ) {
              firstText = true;
              timing("first-text");
            }
            sse(res);
            await write(`event: ${event.event}\ndata: ${event.data}\n\n`);
            published++;
          };
          const header = (name: string) => {
            const value = req.headers[name];
            return typeof value === "string" ? value : undefined;
          };
          const version = header("anthropic-version");
          const beta = header("anthropic-beta");
          let result;
          try {
            result = await abortable(
              gateway.messages(
                capability,
                runtime,
                callId,
                input,
                {
                  ...(version !== undefined ? { version } : {}),
                  ...(beta !== undefined ? { beta } : {}),
                  betaQuery: route.betaQuery
                },
                policy,
                abort.signal,
                publish,
                timing
              ),
              abort.signal
            );
          } catch (error) {
            if (!(error instanceof ModelUpstreamRejection)) throw error;
            // The provider's own error, as the CLI would have received it.
            // Status and the provider's error type only (never the message): enough to diagnose.
            timing(
              "failed",
              undefined,
              `MODEL_UPSTREAM_REJECTED:${error.status}:${errorType(error.body)}`
            );
            if (error.streamed || res.headersSent) {
              sse(res);
              res.end(
                `event: error\ndata: ${error.streamed ? error.body : JSON.stringify({ type: "error", error: { type: "api_error", message: "MODEL_STREAM_FAILED" } })}\n\n`
              );
            } else {
              res.writeHead(error.status, {
                "content-type": "application/json",
                connection: "close",
                ...(error.retryAfter ? { "retry-after": error.retryAfter } : {})
              });
              res.end(error.body);
            }
            return;
          }
          abort.signal.throwIfAborted();
          for (const event of result.events.slice(published)) await publish(event);
        }
        res.end();
        timing("completed");
      } catch (error) {
        // Only the fixed error code is reported, never request or provider content.
        timing("failed", undefined, error instanceof ModelGatewayError ? error.code : "UNEXPECTED");
        fail(error instanceof ModelGatewayError ? error.status : 503);
      } finally {
        active--;
        clearTimeout(deadline);
        clearTimeout(bodyDeadline);
        clearTimeout(expiry);
        res.removeListener("close", disconnected);
        abort.abort();
      }
    }
  );
  server.maxConnections = 64;
  return server;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(Error("MODEL_REQUEST_ABORTED"));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** The provider's error type from an error body (`{error:{type}}` or `{type}`), or `unknown`. */
function errorType(body: string): string {
  try {
    const value = JSON.parse(body) as { type?: unknown; error?: { type?: unknown } };
    const type = value?.error?.type ?? value?.type;
    return typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "unknown";
  } catch {
    return "unknown";
  }
}
