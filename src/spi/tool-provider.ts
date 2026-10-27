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
/** ToolProvider SPI: a catalog of tools plus their invocation. The tool gateway owns
 * authentication, per-Run authorization, concurrency, timeouts and result checks. */

export class ToolGatewayError extends Error {
  /** `reason`: a fixed rule description for the model (never echoes the rejected input). */
  constructor(
    public readonly code: string,
    public readonly reason?: string
  ) {
    super(code);
  }
}

/** A downstream failure the provider classified. Only its code (never data, URLs or credentials)
 * reaches the model, so it can correct the request. `definite`: the downstream answered with a
 * failure, so nothing happened; otherwise the outcome is unknown. `reason`: the downstream's own
 * error code (an identifier such as `file_reference_invalid`, never its message); anything else
 * is dropped. */
export class ToolCallFailed extends ToolGatewayError {
  constructor(
    code: string,
    public readonly definite: boolean,
    reason?: string
  ) {
    super(
      /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "TOOL_CALL_FAILED",
      reason !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reason) ? reason : undefined
    );
  }
}

/** What the user is asked to approve for one call (approval bridge). The gateway adds the tool
 * name; the provider says what the call does. Never credentials. */
export interface ConfirmPrompt {
  /** Short name of the operation (e.g. the downstream API): one line, at most 200 characters. */
  readonly title: string;
  /** Bounded description of the arguments for the user to check, at most 1024 characters. */
  readonly summary: string;
}

/** The request relayed to the user's client: one tool call awaiting approval. */
export interface ConfirmRequest extends ConfirmPrompt {
  readonly kind: "tool_call";
  readonly tool: string;
}

/** The user's verdict. Only `approved` lets the call run; anything else means it did not run.
 * `unattended`: the Run has no one who could answer (e.g. an assigned task with no browser), so
 * nothing was asked. */
export type ConfirmOutcome = "approved" | "rejected" | "timeout" | "unavailable" | "unattended";

/** Codes the model sees when a call did not run for want of approval (never a permission error). */
export const CONFIRMATION_CODES: Readonly<Record<Exclude<ConfirmOutcome, "approved">, string>> =
  Object.freeze({
    rejected: "CONFIRMATION_REJECTED",
    timeout: "CONFIRMATION_TIMEOUT",
    unavailable: "CONFIRMATION_UNAVAILABLE",
    unattended: "CONFIRMATION_UNATTENDED"
  });

export interface ToolInput {
  callId: string;
  toolAlias: string;
  arguments: Readonly<Record<string, unknown>>;
}

export interface ToolDeployment {
  serverId: string;
  serverVersion: number;
  targetRef: string;
  targetVersion: number;
  toolVersion: number;
}

/** Restored Run identity of one call; supplied by the gateway, never by the Harness. */
export type ToolIdentity = ToolDeployment & {
  tenantId: string;
  userId: string;
  actorTenantAccessId: string;
  runId: string;
  /** The lease's opaque identity attributes (see RunIdentity). */
  attributes: Readonly<Record<string, string>>;
};

export interface ToolDescriptor {
  readonly alias: string;
  readonly version: number;
  /** Whether the tool only reads (published as the MCP read-only hint). A tool that may write
   * relies on the downstream service authorizing the Run owner's token. */
  readonly readOnly: boolean;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Strict published schema: reject unknown/nested routing, identity and API overrides. */
  validateParams(params: Readonly<Record<string, unknown>>): void;
}

export interface ToolProvider {
  readonly tools: readonly Readonly<ToolDescriptor>[];
  /** Trusted, registered adapter owns endpoint, TLS and parameter schema. Validate BEFORE key
   * lookup. Reject credential/profile/tenant overrides, including nested ones. */
  validate(input: ToolInput, deployment: Readonly<ToolDeployment>): void;
  /** Audit fields of a call (e.g. the downstream operation name): short identifiers only, never
   * argument values or results. */
  summarize?(input: ToolInput): Readonly<Record<string, string>>;
  /** Approval bridge: whether a validated call needs the user's confirmation under the Run's
   * policy. `operations` are the control plane's patterns (never empty; the provider defines what
   * they match). Returns what to show the user, or undefined to run the call directly. The gateway
   * asks before reading credentials, so a call that is not approved never reaches the downstream. */
  confirmation?(input: ToolInput, operations: readonly string[]): ConfirmPrompt | undefined;
  /** Per-call client; no shared mutable token/client cache or personal config loading.
   * Writes are authorized by the downstream service with the Run owner's token. Throw
   * ToolCallFailed to tell the model why a call failed. */
  invoke(
    input: ToolInput,
    identity: Readonly<ToolIdentity>,
    accessToken: string,
    signal: AbortSignal,
    expiresAt: number
  ): Promise<unknown>;
}
