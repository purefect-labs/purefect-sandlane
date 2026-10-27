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
/** Run credential lookup shared by the lane (which registers leased Runs) and the in-process
 * model and tool gateways (which match scoped capabilities). Secrets stay behind methods. */
import type { ModelWire } from "./model-upstream.js";
import type { ConfirmOutcome, ConfirmRequest } from "./tool-provider.js";
import type { WebAccessPolicy } from "./web-access.js";

/** Non-secret facts about one leased Run, safe to keep in diagnostics. */
export interface RunGrant {
  readonly jobId: string;
  readonly generation: number;
  readonly runId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly userId: string;
  /** Tenant membership of the Run owner. */
  readonly tenantAccessId: string;
  /** Opaque identity attributes from the lease, for tool providers only. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Gateway binding of this allocation; capabilities are only valid with this exact pair. */
  readonly runtime: Readonly<{ runtimeId: string; allocationId: string }>;
  /** Harness ID of the Run and the model API it speaks; the model gateway serves only this entry
   * and this Harness's function inventory to the Run. */
  readonly harness: string;
  readonly modelWire: ModelWire;
  /** Name the CLI sends to the model gateway, and the upstream model it maps to. */
  readonly modelAlias: string;
  readonly providerModel: string;
  readonly baseUri: string;
  readonly enabledTools: readonly string[];
  /** Web access of the Run; the model gateway is its only enforcement point. */
  readonly webAccess: WebAccessPolicy;
  /** File mode (conversation files in the workspace): the Harness's file and command functions
   * are admitted for this Run, and requests may carry the images or documents they read. */
  readonly fileTools?: boolean;
  /** Hard execution deadline handed to the sandbox (also the capabilities' expiry). */
  readonly expiresAt: number;
}

/** The Run's approval bridge: present only when its policy names operations to confirm. */
export interface RunConfirmation {
  /** The lease's patterns (non-empty); the tool provider decides which calls they match. */
  readonly operations: readonly string[];
  /** Asks the user through the Run's lane; resolves with the verdict, never rejects. */
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome>;
}

/** The Run's client action as the tool gateway serves it: offered for this Run only, relayed
 * through the Run's own lane. */
export interface RunClientAction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Relays one call to the user's client and resolves with the receipt for the model; a call
   * that cannot run resolves with a failure receipt. Rejects only when the Run is gone. */
  call(args: unknown, signal: AbortSignal): Promise<unknown>;
}

/** A control plane tool of the Run (see ControlTool in spi/control-plane): served by the tool
 * gateway, answered by the Run's own lane; never needs the Run owner's token. */
export interface RunControlTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Runs one call and resolves with the result for the model; `callId` is the CLI's tool call ID
   * when it sends one. Rejects only when the Run is gone. */
  call(
    args: unknown,
    signal: AbortSignal,
    callId?: string
  ): Promise<{ readonly text: string; readonly failed?: boolean }>;
}

export interface RunCredentialView {
  readonly id: string;
  readonly grant: RunGrant;
  /** Client action offered to this Run; absent when the turn has none. */
  readonly clientAction?: RunClientAction;
  /** Control plane tools offered to this Run; empty when none. */
  readonly controlTools: readonly RunControlTool[];
  /** Approval bridge of this Run; absent when no call needs the user's confirmation. */
  readonly confirmation?: RunConfirmation;
  /** Aborted on revocation or when the lease passes without renewal. */
  readonly signal: AbortSignal;
  modelUsable(now?: number): boolean;
  toolUsable(now?: number): boolean;
  /** Upstream model key, only while the Run holds a live lease. */
  modelKey(now?: number): string | undefined;
  /** Current short-lived control plane token of the Run owner, only while unexpired. */
  agentToken(now?: number): Readonly<{ value: string; expiresAt: number }> | undefined;
  /** `webSearches`: provider-executed web searches billed for the call, when reported. */
  addUsage(
    inputTokens: number | null,
    outputTokens: number | null,
    webSearches?: number | null
  ): void;
}

export interface RunCredentialLookup {
  byModelCapability(value: string): RunCredentialView | undefined;
  byToolCapability(value: string): RunCredentialView | undefined;
  byId(id: string): RunCredentialView | undefined;
}
