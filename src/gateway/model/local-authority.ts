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
import { randomBytes } from "node:crypto";
import {
  ModelGatewayError,
  type ModelAuthority,
  type ModelPermit,
  type ModelProvider,
  type ModelSecrets,
  type RuntimeBinding
} from "./gateway.js";
import { MessagesProvider, type MessagesAuth } from "./messages-provider.js";
import { ResponsesProvider } from "./responses-provider.js";
import { keepAliveSend, type WarmupOptions } from "./upstream-transport.js";
import type { ModelRunBinding } from "./model-server.js";
import type { MessagesUpstream, ModelUpstream, ModelWire } from "../../spi/model-upstream.js";
import type { RunCredentialLookup, RunCredentialView } from "../../spi/run-credentials.js";

/** Deployment policy for model-visible functions and output size; never taken from a request.
 * Function names are per Harness ID: each CLI names the gateway's tools its own way.
 * `webFunctions`: per Harness, its own tools built on the provider's web search (offered only to
 * Runs with web access). `fileFunctions`: per Harness, its built-in file and command tools,
 * admitted only for file-mode Runs (conversation files in the sandbox); any other Run that sends
 * them is rejected like any unknown function. */
export interface LocalModelPolicy {
  readonly functions: Readonly<Record<string, readonly string[]>>;
  readonly webFunctions?: Readonly<Record<string, readonly string[]>>;
  readonly fileFunctions?: Readonly<Record<string, readonly string[]>>;
  readonly maxOutputTokens: number;
}

/** Upstream clients per base URI, one per wire the gateway serves. */
export interface UpstreamFactory {
  responses(baseUri: string): ModelUpstream;
  messages(baseUri: string): MessagesUpstream;
}

interface Call {
  readonly credential: RunCredentialView;
  readonly receipt: string;
  dispatched: boolean;
}

const MAX_CALLS = 1024;

/** Upstreams share one keep-alive connection pool (one per authority, i.e. per process) so
 * consecutive turns skip the TLS handshake and warm-up requests fill the pool real calls use.
 * `messagesAuth`: how the Messages provider key is sent (deployment choice per relay);
 * `warmup.log` receives the preconnect diagnostics (codes and durations only). */
export function defaultUpstreams(
  messagesAuth: MessagesAuth = "x-api-key",
  warmup?: WarmupOptions
): UpstreamFactory {
  const send = keepAliveSend({}, warmup);
  return {
    responses: baseUri => new ResponsesProvider(baseUri, send),
    messages: baseUri => new MessagesProvider(baseUri, send, messagesAuth)
  };
}
const MAX_UPSTREAMS = 32;

/** In-process replacement of the Engine model authority (53 §4.3): the Run's model service
 * credential arrives with the lease and is matched locally by capability. No per-call Engine
 * round trip; usage is accumulated per Run for the complete() summary. Billing stays upstream. */
export class LocalModelAuthority implements ModelAuthority, ModelSecrets {
  readonly #calls = new Map<string, Call>();
  readonly #upstreams = new Map<string, ModelUpstream | MessagesUpstream>();
  readonly #policy: LocalModelPolicy;

  constructor(
    private readonly registry: RunCredentialLookup,
    policy: LocalModelPolicy,
    private readonly upstreams: UpstreamFactory = defaultUpstreams()
  ) {
    const functions = Object.entries(policy.functions ?? {});
    const webFunctions = Object.entries(policy.webFunctions ?? {});
    const fileFunctions = Object.entries(policy.fileFunctions ?? {});
    if (
      !policy.functions ||
      typeof policy.functions !== "object" ||
      Array.isArray(policy.functions) ||
      functions.some(([, names]) => !Array.isArray(names) || names.length > 64) ||
      (policy.webFunctions !== undefined &&
        (!policy.webFunctions ||
          typeof policy.webFunctions !== "object" ||
          Array.isArray(policy.webFunctions))) ||
      webFunctions.some(([, names]) => !Array.isArray(names) || names.length > 8) ||
      (policy.fileFunctions !== undefined &&
        (!policy.fileFunctions ||
          typeof policy.fileFunctions !== "object" ||
          Array.isArray(policy.fileFunctions))) ||
      fileFunctions.some(([, names]) => !Array.isArray(names) || names.length > 8) ||
      !Number.isSafeInteger(policy.maxOutputTokens) ||
      policy.maxOutputTokens < 16 ||
      policy.maxOutputTokens > 1_000_000
    )
      throw new Error("Invalid model policy");
    this.#policy = Object.freeze({
      functions: Object.freeze(
        Object.fromEntries(functions.map(([id, names]) => [id, Object.freeze([...names])]))
      ),
      webFunctions: Object.freeze(
        Object.fromEntries(webFunctions.map(([id, names]) => [id, Object.freeze([...names])]))
      ),
      fileFunctions: Object.freeze(
        Object.fromEntries(fileFunctions.map(([id, names]) => [id, Object.freeze([...names])]))
      ),
      maxOutputTokens: policy.maxOutputTokens
    });
  }

  /** Validate (and cache) the Run's upstream before a sandbox is started. Throws if unsupported. */
  admit(credential: RunCredentialView): void {
    this.#upstream(credential.grant.modelWire, credential.grant.baseUri);
  }

  /** Start connecting to the Run's upstream in the background, in parallel with sandbox
   * preparation. Sends no credentials, never throws and never delays the caller. */
  warm(credential: RunCredentialView): void {
    try {
      this.#upstream(credential.grant.modelWire, credential.grant.baseUri).warm?.();
    } catch {
      /* Best effort: admit() reports unsupported upstreams. */
    }
  }

  /** ModelRunLookup for the model server. */
  readonly lookup = async (capability: string): Promise<ModelRunBinding | null> => {
    const credential = this.registry.byModelCapability(capability);
    if (!credential?.modelUsable()) return null;
    const { harness } = credential.grant;
    const files = credential.grant.fileTools === true;
    const base = Object.hasOwn(this.#policy.functions, harness)
      ? this.#policy.functions[harness]!
      : [];
    const fileFunctions =
      files && Object.hasOwn(this.#policy.fileFunctions!, harness)
        ? this.#policy.fileFunctions![harness]!
        : [];
    return Object.freeze({
      runtime: credential.grant.runtime,
      // Renewal happens per sync; revocation/lease loss aborts in-flight calls via the
      // Run signal (see provider()), so the binding itself only carries the hard deadline.
      expiresAt: credential.grant.expiresAt,
      wire: credential.grant.modelWire,
      functions: fileFunctions.length ? [...new Set([...base, ...fileFunctions])] : base,
      maxOutputTokens: this.#policy.maxOutputTokens,
      webAccess: credential.grant.webAccess,
      webFunctions: Object.hasOwn(this.#policy.webFunctions!, harness)
        ? this.#policy.webFunctions![harness]!
        : [],
      ...(files ? { fileTools: true } : {})
    });
  };

  /** Provider resolver for ModelGateway: per-Run wrapper over the shared upstream client. */
  readonly provider = (providerId: string): ModelProvider | undefined => {
    const match = /^run-([0-9a-f-]{36})$/.exec(providerId);
    const credential = match ? this.registry.byId(match[1]!) : undefined;
    if (!credential) return undefined;
    const { modelWire, baseUri } = credential.grant;
    let upstream: ModelUpstream | MessagesUpstream;
    try {
      upstream = this.#upstream(modelWire, baseUri);
    } catch {
      return undefined;
    }
    // Only the entry of the Run's own wire reaches its upstream.
    return {
      invoke: async () => {
        throw new ModelGatewayError("MODEL_PROVIDER_UNAVAILABLE", 503);
      },
      ...(modelWire === "responses"
        ? {
            respond: (request, model, secret, forbidden, signal, publish, timing) =>
              (upstream as ModelUpstream).invoke(
                request,
                model,
                secret,
                forbidden,
                AbortSignal.any([signal, credential.signal]),
                publish,
                timing
              )
          }
        : {
            messages: (call, model, secret, forbidden, signal, publish, timing) =>
              (upstream as MessagesUpstream).invoke(
                call,
                model,
                secret,
                forbidden,
                AbortSignal.any([signal, credential.signal]),
                publish,
                timing
              )
          })
    } satisfies ModelProvider;
  };

  async reserve(input: Parameters<ModelAuthority["reserve"]>[0]): Promise<ModelPermit> {
    const credential = this.#current(input.capability, input.runtime);
    const call = input.call;
    if (call.modelAlias !== credential.grant.modelAlias)
      throw new ModelGatewayError("MODEL_ACCESS_DENIED", 403);
    if (this.#calls.has(call.callId)) throw new ModelGatewayError("MODEL_CALL_CONFLICT", 409);
    if (this.#calls.size >= MAX_CALLS) throw new ModelGatewayError("MODEL_CAPACITY", 429);
    const receipt = randomBytes(32).toString("base64url");
    this.#calls.set(call.callId, { credential, receipt, dispatched: false });
    return {
      tenantId: credential.grant.tenantId,
      runId: credential.grant.runId,
      callId: call.callId,
      providerId: `run-${credential.id}`,
      providerModel: credential.grant.providerModel,
      secretRef: "model_service.api_key",
      bindingVersion: 1,
      maxOutputTokens: call.maxOutputTokens,
      receipt
    };
  }

  async read(input: Parameters<ModelSecrets["read"]>[0]): Promise<string> {
    const credential = this.#current(input.capability, input.runtime);
    const call = this.#calls.get(input.permit.callId);
    if (!call || call.credential !== credential || call.receipt !== input.permit.receipt)
      throw new ModelGatewayError("MODEL_ACCESS_DENIED", 403);
    const key = credential.modelKey();
    if (!key) throw new ModelGatewayError("MODEL_SECRET_UNAVAILABLE", 503);
    return key;
  }

  async dispatch(input: Parameters<ModelAuthority["dispatch"]>[0]): Promise<void> {
    // Recheck after the key read: revocation or lease loss in between must stop the send.
    const credential = this.#current(input.capability, input.runtime);
    const call = this.#calls.get(input.callId);
    if (
      !call ||
      call.credential !== credential ||
      call.receipt !== input.receipt ||
      call.dispatched
    )
      throw new ModelGatewayError("MODEL_CALL_CONFLICT", 409);
    call.dispatched = true;
  }

  async finish(input: Parameters<ModelAuthority["finish"]>[0]): Promise<void> {
    const call = this.#calls.get(input.permit.callId);
    if (!call || call.receipt !== input.permit.receipt) return;
    this.#calls.delete(input.permit.callId);
    call.credential.addUsage(input.inputTokens, input.outputTokens, input.webSearches ?? null);
  }

  #current(capability: string, runtime: RuntimeBinding): RunCredentialView {
    const credential = this.registry.byModelCapability(capability);
    if (
      !credential ||
      !credential.modelUsable() ||
      runtime?.runtimeId !== credential.grant.runtime.runtimeId ||
      runtime?.allocationId !== credential.grant.runtime.allocationId
    )
      throw new ModelGatewayError("MODEL_ACCESS_DENIED", 403);
    return credential;
  }

  #upstream(wire: ModelWire, baseUri: string): ModelUpstream | MessagesUpstream {
    const key = `${wire} ${baseUri}`;
    let upstream = this.#upstreams.get(key);
    if (!upstream) {
      if (wire === "responses") upstream = this.upstreams.responses(baseUri);
      else if (wire === "anthropic-messages") upstream = this.upstreams.messages(baseUri);
      else throw new Error("MODEL_WIRE_UNSUPPORTED");
      if (this.#upstreams.size >= MAX_UPSTREAMS)
        this.#upstreams.delete(this.#upstreams.keys().next().value!);
      this.#upstreams.set(key, upstream);
    }
    return upstream;
  }
}
