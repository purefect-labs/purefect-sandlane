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
/** ModelUpstream SPI: one upstream model service, reached with the Run's model credential.
 * The model gateway selects its entry codec by the Harness `modelWire`: `responses` and
 * `anthropic-messages` are implemented, `chat-completions` is reserved. */

export type ModelWire = "responses" | "anthropic-messages" | "chat-completions";

/** Trusted deployment extension, never loaded from user input or lease module names.
 * Implementations must preserve credential isolation, cancellation, bounded streams,
 * approved tool inventory and validated usage/terminal events. A factory is shared by Runs:
 * do not store per-Run secrets or mutable request state on cached upstream instances.
 * Chat Completions is not implemented by the bundled gateway; conversion requires a
 * separately tested adapter implementing the selected Harness wire contract. */
export interface ModelUpstreamFactory {
  responses(baseUri: string): ModelUpstream;
  messages(baseUri: string): MessagesUpstream;
}

/** Stateless, text/function-only Responses request accepted by the gateway entry codec. */
export interface ManagedResponsesRequest {
  readonly model: string;
  readonly max_output_tokens: number;
  readonly stream: true;
  readonly store: false;
  readonly [key: string]: unknown;
}

export interface ResponsesEvent {
  readonly type: string;
  readonly sequence_number: number;
  readonly [key: string]: unknown;
}

/** Token usage of one call; `webSearches`: provider-executed web searches, when reported. */
export type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  webSearches?: number;
}>;

export interface ResponsesResult {
  readonly events: readonly ResponsesEvent[];
  readonly usage: ModelUsage;
}

/** Provisional events only; completion is published after durable accounting. */
export type ResponsesSink = (event: ResponsesEvent) => Promise<void>;

export interface ResponsesRequestMetrics {
  requestBytes: number;
  inputItems: number;
  toolDefinitions: number;
  reasoningEffort: string;
  maxOutputTokens: number;
  /** Request shape for diagnosis: top-level fields, tool types and beta flags (names only). */
  shape?: string;
}

export type ResponsesTiming = (phase: string, metrics?: ResponsesRequestMetrics) => void;

export interface ModelUpstream {
  /** Send one request upstream. `forbiddenValues` (credentials) must never appear in output. */
  invoke(
    request: ManagedResponsesRequest,
    providerModel: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: ResponsesSink,
    timing?: ResponsesTiming
  ): Promise<ResponsesResult>;
  /** Open a connection ahead of the first call; sends no credentials, never throws. */
  warm?(): void;
}

/** One Anthropic Messages SSE event: its name and the JSON data line exactly as received. */
export interface MessagesEvent {
  readonly event: string;
  readonly data: string;
}

/** Validated Messages request (fields other than the checked ones pass through unchanged) plus
 * the CLI's protocol headers. */
export interface MessagesCall {
  readonly body: Readonly<Record<string, unknown>> & {
    readonly model: string;
    readonly max_tokens: number;
    readonly stream: true;
  };
  /** `anthropic-version` and `anthropic-beta` as sent by the CLI. */
  readonly version?: string;
  readonly beta?: string;
  /** The CLI used the SDK's `?beta=true` endpoint form. */
  readonly betaQuery: boolean;
}

export interface MessagesResult {
  /** Every forwarded event; those not yet published (held back) are published by the caller
   * after accounting. */
  readonly events: readonly MessagesEvent[];
  readonly usage: ModelUsage;
}

/** Provisional events only; the terminal event is published after durable accounting. */
export type MessagesSink = (event: MessagesEvent) => Promise<void>;

export interface MessagesUpstream {
  /** Send one streamed request upstream. `forbiddenValues` (credentials) must never appear in
   * output. Throws ModelUpstreamRejection for an HTTP error the CLI should see. */
  invoke(
    call: MessagesCall,
    providerModel: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: MessagesSink,
    timing?: ResponsesTiming
  ): Promise<MessagesResult>;
  /** Open a connection ahead of the first call; sends no credentials, never throws. */
  warm?(): void;
}

/** An upstream error returned to the CLI unchanged: status, a bounded JSON body free of
 * credentials and the provider's retry hint. The CLI's own retry and error handling depend on it.
 * `streamed`: the provider reported it as an SSE `error` event, forwarded as the stream's last
 * event (`body` is its data). */
export class ModelUpstreamRejection extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter?: string,
    readonly streamed = false
  ) {
    super("MODEL_UPSTREAM_REJECTED");
  }
}
