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
import { createHash } from "node:crypto";
import { parseMessagesRequest } from "./messages-request.js";
import { parseResponsesRequest, type ManagedResponsesRequest } from "./responses-request.js";
import { NO_WEB, type WebPolicy } from "./web-access.js";
import type { ResponsesResult, ResponsesSink, ResponsesTiming } from "./responses-provider.js";
import {
  ModelUpstreamRejection,
  type MessagesCall,
  type MessagesResult,
  type MessagesSink
} from "../../spi/model-upstream.js";

export class ModelGatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
  }
}
export interface ModelInput {
  callId: string;
  modelAlias: string;
  messages: ReadonlyArray<Readonly<{ role: "system" | "user" | "assistant"; content: string }>>;
  maxOutputTokens: number;
}
export interface RuntimeBinding {
  runtimeId: string;
  allocationId: string;
}
export interface ModelPermit {
  tenantId: string;
  runId: string;
  callId: string;
  providerId: string;
  providerModel: string;
  secretRef: string;
  bindingVersion: number;
  maxOutputTokens: number;
  receipt: string;
}
export interface ModelResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; webSearches?: number };
}
/** Trusted per-Run policy of the CLI entries; never taken from a request. */
export interface EntryPolicy {
  readonly functions: readonly string[];
  readonly maxOutputTokens: number;
  /** Absent = no web access. */
  readonly web?: WebPolicy;
  /** File mode: larger requests with inline images and documents (see file-mode). */
  readonly files?: boolean;
}
export interface ModelAuthority {
  reserve(
    input: {
      capability: string;
      runtime: RuntimeBinding;
      call: Omit<ModelInput, "messages"> & { requestDigest: string };
    },
    signal: AbortSignal
  ): Promise<ModelPermit>;
  dispatch(
    input: { capability: string; runtime: RuntimeBinding; callId: string; receipt: string },
    signal: AbortSignal
  ): Promise<void>;
  finish(
    input: {
      permit: ModelPermit;
      runtime: RuntimeBinding;
      outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
      resultDigest: string;
      inputTokens: number | null;
      outputTokens: number | null;
      /** Provider-executed web searches of the call, when reported. */
      webSearches?: number | null;
    },
    signal: AbortSignal
  ): Promise<void>;
}
export interface ModelSecrets {
  /** Trusted Gateway only. Source must resolve the persisted receipt and recheck current MODEL
   * capability/runtime and policy before AND after reading material. permit.secretRef alone is
   * not authority; no arbitrary-reference/personal-profile fallback is allowed. */
  read(
    input: { permit: Readonly<ModelPermit>; capability: string; runtime: Readonly<RuntimeBinding> },
    signal: AbortSignal
  ): Promise<string>;
}
/** A registered trusted adapter owns endpoint, protocol and TLS policy. Never take a URL, headers,
 * provider key or remote tool definitions from ModelInput. Adapters MUST honor AbortSignal. */
export interface ModelProvider {
  invoke(
    input: { model: string; messages: ModelInput["messages"]; maxOutputTokens: number },
    secret: string,
    signal: AbortSignal
  ): Promise<ModelResult>;
  respond?(
    input: ManagedResponsesRequest,
    model: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: ResponsesSink,
    timing?: ResponsesTiming
  ): Promise<ResponsesResult>;
  messages?(
    call: MessagesCall,
    model: string,
    secret: string,
    forbiddenValues: readonly string[],
    signal: AbortSignal,
    publish?: MessagesSink,
    timing?: ResponsesTiming
  ): Promise<MessagesResult>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(value).some(k => !expected.includes(k)) ||
    expected.some(k => !Object.hasOwn(value, k))
  )
    throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
}
export function modelIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value))
    throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
  return value;
}
/** Strict, text-only contract for the first Gateway slice. No streaming/tool/image/URL pass-through. */
export function parseModelInput(value: unknown): Readonly<ModelInput> {
  const v = record(value);
  keys(v, ["callId", "modelAlias", "messages", "maxOutputTokens"]);
  if (
    !Array.isArray(v.messages) ||
    v.messages.length < 1 ||
    v.messages.length > 100 ||
    !Number.isSafeInteger(v.maxOutputTokens) ||
    Number(v.maxOutputTokens) < 1 ||
    Number(v.maxOutputTokens) > 1_000_000
  ) {
    throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
  }
  let bytes = 0;
  const messages = v.messages.map(item => {
    const m = record(item);
    keys(m, ["role", "content"]);
    if (!["system", "user", "assistant"].includes(String(m.role)) || typeof m.content !== "string")
      throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
    bytes += Buffer.byteLength(m.content);
    if (bytes > 32_000) throw new ModelGatewayError("MODEL_INPUT_LIMIT", 413);
    return Object.freeze({ role: m.role as "system" | "user" | "assistant", content: m.content });
  });
  return Object.freeze({
    callId: modelIdentifier(v.callId),
    modelAlias: modelIdentifier(v.modelAlias),
    messages: Object.freeze(messages),
    maxOutputTokens: Number(v.maxOutputTokens)
  });
}
export function modelDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Abort a dependency wait even if it fails to honor the signal. Late authorization may have reserved
 * a call: the durable ledger must retain that uncertainty; NEVER retry with a fresh call ID here. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new ModelGatewayError("MODEL_REQUEST_ABORTED", 503));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Trusted service-side kernel, not itself a production deployment. No global user/credential state,
 * default provider, auth bypass, automatic fallback or provider retries. */
export class ModelGateway {
  private active = 0;
  private readonly providers: (providerId: string) => ModelProvider | undefined;
  constructor(
    private readonly authority: ModelAuthority,
    private readonly secrets: ModelSecrets,
    /** Static registry, or a trusted resolver for per-Run upstreams (base URI from the lease). */
    providers:
      | ReadonlyMap<string, ModelProvider>
      | ((providerId: string) => ModelProvider | undefined),
    private readonly settings = { maxConcurrent: 5, timeoutMs: 120_000, receiptTimeoutMs: 5_000 }
  ) {
    if (
      !Number.isInteger(settings.maxConcurrent) ||
      settings.maxConcurrent < 1 ||
      settings.maxConcurrent > 100 ||
      !Number.isInteger(settings.timeoutMs) ||
      settings.timeoutMs < 10 ||
      // Long reasoning or answers stream for minutes; the Run deadline (30 min) is the ceiling.
      settings.timeoutMs > 1_800_000 ||
      !Number.isInteger(settings.receiptTimeoutMs) ||
      settings.receiptTimeoutMs < 10 ||
      settings.receiptTimeoutMs > 10_000
    )
      throw new Error("Invalid Model Gateway limits");
    if (typeof providers === "function") this.providers = providers;
    else {
      const copy = new Map(providers);
      this.providers = id => copy.get(id);
    }
  }

  async invoke(
    capability: string,
    runtime: RuntimeBinding,
    value: unknown,
    callerSignal = new AbortController().signal
  ): Promise<ModelResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability))
      throw new ModelGatewayError("MODEL_CAPABILITY_REQUIRED", 401);
    const input = parseModelInput(value);
    return this.authorizedCall(
      capability,
      runtime,
      {
        callId: input.callId,
        modelAlias: input.modelAlias,
        maxOutputTokens: input.maxOutputTokens,
        requestDigest: modelDigest({
          modelAlias: input.modelAlias,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens
        })
      },
      async (provider, permit, secret, signal) => {
        const raw = await provider.invoke(
          {
            model: permit.providerModel,
            messages: input.messages,
            maxOutputTokens: input.maxOutputTokens
          },
          secret,
          signal
        );
        if (
          !raw ||
          typeof raw.text !== "string" ||
          Buffer.byteLength(raw.text) > 64_000 ||
          [secret, capability, permit.receipt].some(credential => raw.text.includes(credential))
        )
          throw new ModelGatewayError("MODEL_PROVIDER_PROTOCOL", 502);
        const result: ModelResult = { text: raw.text };
        if (raw.usage !== undefined) {
          validateUsage(raw.usage);
          result.usage = {
            inputTokens: raw.usage.inputTokens,
            outputTokens: raw.usage.outputTokens
          };
        }
        return result;
      },
      callerSignal
    );
  }

  /** Provisional text may stream after dispatch. Final success still requires durable accounting. */
  async respond(
    capability: string,
    runtime: RuntimeBinding,
    callId: string,
    value: unknown,
    policy: EntryPolicy,
    signal = new AbortController().signal,
    publish?: ResponsesSink,
    timing: ResponsesTiming = () => {}
  ): Promise<ResponsesResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability))
      throw new ModelGatewayError("MODEL_CAPABILITY_REQUIRED", 401);
    let request: ManagedResponsesRequest;
    try {
      request = parseResponsesRequest(
        value,
        policy.functions,
        policy.maxOutputTokens,
        policy.web ?? NO_WEB,
        policy.files === true
      );
    } catch {
      throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
    }
    return this.authorizedCall(
      capability,
      runtime,
      {
        callId: modelIdentifier(callId),
        modelAlias: request.model,
        maxOutputTokens: request.max_output_tokens,
        requestDigest: modelDigest(request)
      },
      async (provider, permit, secret, boundedSignal) => {
        if (!provider.respond) throw new ModelGatewayError("MODEL_PROVIDER_UNAVAILABLE", 503);
        const result = await provider.respond(
          request,
          permit.providerModel,
          secret,
          [capability, permit.receipt],
          boundedSignal,
          publish,
          timing
        );
        validateUsage(result.usage);
        return result;
      },
      signal,
      timing
    );
  }

  /** Anthropic Messages entry: same authorization and accounting as respond(); upstream HTTP
   * errors reach the CLI unchanged (ModelUpstreamRejection). */
  async messages(
    capability: string,
    runtime: RuntimeBinding,
    callId: string,
    value: unknown,
    headers: Readonly<{ version?: string; beta?: string; betaQuery: boolean }>,
    policy: EntryPolicy,
    signal = new AbortController().signal,
    publish?: MessagesSink,
    timing: ResponsesTiming = () => {}
  ): Promise<MessagesResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability))
      throw new ModelGatewayError("MODEL_CAPABILITY_REQUIRED", 401);
    let call: MessagesCall;
    try {
      call = parseMessagesRequest(
        value,
        headers,
        policy.functions,
        policy.maxOutputTokens,
        policy.web ?? NO_WEB,
        policy.files === true
      );
    } catch {
      throw new ModelGatewayError("INVALID_MODEL_REQUEST", 400);
    }
    return this.authorizedCall(
      capability,
      runtime,
      {
        callId: modelIdentifier(callId),
        modelAlias: call.body.model,
        maxOutputTokens: call.body.max_tokens,
        requestDigest: modelDigest(call)
      },
      async (provider, permit, secret, boundedSignal) => {
        if (!provider.messages) throw new ModelGatewayError("MODEL_PROVIDER_UNAVAILABLE", 503);
        const result = await provider.messages(
          call,
          permit.providerModel,
          secret,
          [capability, permit.receipt],
          boundedSignal,
          publish,
          timing
        );
        validateUsage(result.usage);
        return result;
      },
      signal,
      timing
    );
  }

  private async authorizedCall<T extends { readonly usage?: ModelResult["usage"] }>(
    capability: string,
    runtime: RuntimeBinding,
    input: { callId: string; modelAlias: string; maxOutputTokens: number; requestDigest: string },
    operation: (
      provider: ModelProvider,
      permit: ModelPermit,
      secret: string,
      signal: AbortSignal
    ) => Promise<T>,
    callerSignal: AbortSignal,
    timing: (phase: string) => void = () => {}
  ): Promise<T> {
    const binding = Object.freeze({
      runtimeId: modelIdentifier(runtime.runtimeId),
      allocationId: modelIdentifier(runtime.allocationId)
    });
    if (this.active >= this.settings.maxConcurrent)
      throw new ModelGatewayError("MODEL_GATEWAY_BUSY", 429);
    this.active++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.settings.timeoutMs);
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    let permit: ModelPermit | undefined;
    let dispatched = false;
    let settling = false;
    try {
      signal.throwIfAborted();
      const authorization = await bounded(
        this.authority.reserve({ capability, runtime: binding, call: { ...input } }, signal),
        signal
      );
      timing("reserved");
      // Clone to prevent another request/client from mutating a shared authority response object.
      permit = Object.freeze({ ...authorization });
      if (
        typeof permit.tenantId !== "string" ||
        typeof permit.runId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(permit.tenantId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(permit.runId) ||
        permit.callId !== input.callId ||
        permit.maxOutputTokens !== input.maxOutputTokens ||
        !Number.isSafeInteger(permit.bindingVersion) ||
        permit.bindingVersion < 1 ||
        typeof permit.receipt !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(permit.receipt)
      ) {
        permit = undefined;
        throw new ModelGatewayError("MODEL_AUTHORITY_PROTOCOL", 503);
      }
      for (const id of [permit.providerId, permit.providerModel, permit.secretRef])
        modelIdentifier(id);
      const provider = this.providers(permit.providerId);
      if (!provider) throw new ModelGatewayError("MODEL_PROVIDER_UNAVAILABLE", 503);
      signal.throwIfAborted();
      const secret = await bounded(
        this.secrets.read(Object.freeze({ permit, capability, runtime: binding }), signal),
        signal
      );
      timing("credential-read");
      if (typeof secret !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(secret))
        throw new ModelGatewayError("MODEL_SECRET_UNAVAILABLE", 503);
      signal.throwIfAborted();
      // Key lookup may have been slow. Recheck current IAM/policy and atomically consume dispatch once.
      await bounded(
        this.authority.dispatch(
          { capability, runtime: binding, callId: input.callId, receipt: permit.receipt },
          signal
        ),
        signal
      );
      signal.throwIfAborted();
      dispatched = true;
      timing("dispatched");
      const result = await bounded(operation(provider, permit, secret, signal), signal);
      signal.throwIfAborted();
      settling = true;
      await this.finish(permit, binding, "SUCCEEDED", modelDigest(result), result.usage);
      timing("accounted");
      return result; // Do not publish success before durable accounting acknowledgement.
    } catch (error) {
      if (permit && !settling) {
        settling = true;
        await this.finish(
          permit,
          binding,
          dispatched ? "UNKNOWN" : "FAILED",
          modelDigest({ outcome: dispatched ? "UNKNOWN" : "FAILED" })
        );
      }
      // The provider's own HTTP error, already bounded and checked for credentials.
      if (error instanceof ModelUpstreamRejection) throw error;
      // Never forward dependency errors, endpoints, prompt, credentials, or provider response bodies.
      const publicErrors: Record<string, number> = {
        MODEL_PROVIDER_UNAVAILABLE: 503,
        MODEL_SECRET_UNAVAILABLE: 503,
        MODEL_PROVIDER_PROTOCOL: 502,
        MODEL_AUTHORITY_PROTOCOL: 503,
        MODEL_REQUEST_ABORTED: 503,
        MODEL_RECEIPT_UNCONFIRMED: 503,
        MODEL_ACCESS_DENIED: 403,
        MODEL_CALL_CONFLICT: 409,
        MODEL_CAPACITY: 429
      };
      if (error instanceof ModelGatewayError && Object.hasOwn(publicErrors, error.code))
        throw new ModelGatewayError(error.code, publicErrors[error.code]!);
      throw new ModelGatewayError("MODEL_REQUEST_REJECTED", 503);
    } finally {
      clearTimeout(timer);
      this.active--;
    }
  }

  private async finish(
    permit: ModelPermit,
    runtime: RuntimeBinding,
    outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
    resultDigest: string,
    usage?: ModelResult["usage"]
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.receiptTimeoutMs);
    try {
      await bounded(
        this.authority.finish(
          {
            permit,
            runtime,
            outcome,
            resultDigest,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            webSearches: usage?.webSearches ?? null
          },
          controller.signal
        ),
        controller.signal
      );
    } catch {
      throw new ModelGatewayError("MODEL_RECEIPT_UNCONFIRMED", 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateUsage(usage: NonNullable<ModelResult["usage"]>): void {
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    (usage.webSearches !== undefined &&
      (!Number.isSafeInteger(usage.webSearches) || usage.webSearches < 0))
  )
    throw new ModelGatewayError("MODEL_PROVIDER_PROTOCOL", 502);
}
