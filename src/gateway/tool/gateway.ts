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
import { toolRequestDigest } from "./request-digest.js";
import { CONFIRMATION_CODES, ToolCallFailed, ToolGatewayError, type ConfirmOutcome, type ConfirmRequest,
  type ToolDeployment, type ToolInput, type ToolProvider } from "../../spi/tool-provider.js";

export { ToolCallFailed, ToolGatewayError };
export type { ToolDeployment, ToolInput };
export interface ToolRuntime { runtimeId: string; allocationId: string }
/** Supplied only by the authenticated authority, never by the browser or Harness.
 * subjectUserId is the downstream credential owner, not the configuring administrator. */
export interface ToolPermit extends ToolDeployment {
  tenantId: string; userId: string; subjectUserId: string; runId: string;
  /** The lease's opaque identity attributes, passed through to the tool provider. */
  attributes: Readonly<Record<string, string>>;
  /** Actual tenant membership IDs, not aliases of the user ID. */
  actorTenantAccessId: string; credentialOwnerTenantAccessId: string;
  callId: string; toolAlias: string; requestDigest: string;
  credentialRef: string; credentialRow: string | null;
  bindingVersion: number; credentialVersion: number; expiresAt: number; receipt: string;
}
export interface ToolAuthority {
  /** Atomically reserve callId and reject duplicate dispatch, expired Run, revoked membership,
   * unpublished MCP, forbidden tool and missing approval. Must use current primary state. */
  reserve(input: { capability: string; runtime: ToolRuntime; call: ToolInput; requestDigest: string }, signal: AbortSignal): Promise<ToolPermit>;
  /** Recheck identity, credential binding/version and policy, then consume the receipt once.
   * Bind receipt to the exact request digest; no caller-selected credential substitution. */
  dispatch(input: { capability: string; runtime: ToolRuntime; permit: ToolPermit }, signal: AbortSignal): Promise<void>;
  finish(input: { runtime: ToolRuntime; permit: ToolPermit; outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN"; resultDigest: string }, signal: AbortSignal): Promise<void>;
  /** Approval bridge of the Run behind the capability: its policy (non-empty) and the channel that
   * asks the user. Undefined = no call of this Run needs confirmation (nothing is asked). */
  confirmation?(input: { capability: string; runtime: ToolRuntime }): ToolConfirmation | undefined;
}
export interface ToolConfirmation {
  readonly operations: readonly string[];
  /** Resolves with the user's verdict; never rejects. */
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome>;
}
export interface ToolSecrets {
  /** Resolve in the exact tenant/user context. For field references verify the actual row owner,
   * active binding and tenant (no tenant/org fallback). No environment or personal-profile fallback.
   * Long-lived user tokens need a user-bound exchange here; return only short-lived access tokens. */
  read(permit: ToolPermit, signal: AbortSignal, execution: Readonly<{ capability: string; runtime: ToolRuntime }>): Promise<{ accessToken: string; expiresAt: number }>;
}
/** The invocation half of a ToolProvider, as registered per server. */
export type ManagedTool = Pick<ToolProvider, "validate" | "invoke" | "summarize" | "confirmation">;
/** One audit record per call that reached the authority: identifiers, the provider's short
 * summary (e.g. the downstream operation) and the outcome, never arguments or results. */
export interface ToolAuditEntry {
  readonly run: string; readonly tool: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "REJECTED";
  readonly code?: string; readonly ms: number;
  readonly fields: Readonly<Record<string, string>>;
}
export type ToolAudit = (entry: ToolAuditEntry) => void;
const deny = (code: string): never => { throw new ToolGatewayError(code); };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v);
/** Opaque identity attributes: a small flat map of bounded strings. */
const attributes = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length <= 16 && Object.entries(v).every(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && typeof value === "string" && value.length <= 256);
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function snapshot(value: unknown, maxBytes: number): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { deny("TOOL_PROTOCOL"); }
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw new ToolGatewayError("TOOL_PROTOCOL");
  const freeze = (v: unknown): unknown => {
    if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
  };
  return freeze(JSON.parse(encoded));
}
function parse(value: unknown): ToolInput {
  // Room for 32 KB of tool parameters plus the call envelope.
  const v = snapshot(value, 40_000) as ToolInput;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).sort().join(",") !== "arguments,callId,toolAlias" || !id(v.callId) || !id(v.toolAlias) ||
      !v.arguments || typeof v.arguments !== "object" || Array.isArray(v.arguments)) deny("INVALID_TOOL_INPUT");
  return v;
}
function check(p: ToolPermit, input: ToolInput, hash: string): void {
  if (!p || !id(p.tenantId) || !id(p.userId) || !id(p.runId) || !id(p.actorTenantAccessId) ||
      p.actorTenantAccessId !== p.credentialOwnerTenantAccessId ||
      p.userId !== p.subjectUserId || !attributes(p.attributes) || !id(p.serverId) || !opaque(p.receipt) ||
      typeof p.targetRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(p.targetRef) ||
      ![p.serverVersion, p.targetVersion, p.toolVersion].every(v => Number.isSafeInteger(v) && v > 0) ||
      p.callId !== input.callId || p.toolAlias !== input.toolAlias || p.requestDigest !== hash ||
      !Number.isSafeInteger(p.bindingVersion) || p.bindingVersion < 1 ||
      !Number.isSafeInteger(p.credentialVersion) || p.credentialVersion < 1 ||
      !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now()) deny("TOOL_AUTHORITY_PROTOCOL");
  const vault = /^\$\{secret:\/\/vault::[A-Za-z0-9][A-Za-z0-9_./-]{0,255}\}$/.test(p.credentialRef);
  const field = /^\$\{secret:\/\/field::[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}#[A-Za-z0-9_]{1,128}\}$/.test(p.credentialRef);
  if (!(vault && p.credentialRow === null) && !(field && id(p.credentialRow))) deny("TOOL_AUTHORITY_PROTOCOL");
}
const RESULT_LIMIT = 64_000;
const TITLE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const SUMMARY = /^[^\u0000-\u0009\u000b-\u001f\u007f]{0,1024}$/;
/** The approval request for a call, or undefined when it runs directly. A provider that cannot
 * describe the call it wants confirmed gets an unusable request, so the call does not run. */
function confirmRequest(tool: ManagedTool, input: ToolInput, operations: readonly string[]): ConfirmRequest | null | undefined {
  let prompt: ReturnType<NonNullable<ManagedTool["confirmation"]>>;
  try { prompt = tool.confirmation?.(input, operations); } catch { return null; }
  if (prompt === undefined) return undefined;
  if (!prompt || typeof prompt.title !== "string" || !TITLE.test(prompt.title) ||
      typeof prompt.summary !== "string" || !SUMMARY.test(prompt.summary)) return null;
  return Object.freeze({ kind: "tool_call", tool: input.toolAlias, title: prompt.title, summary: prompt.summary });
}
/** The provider's audit fields: at most 8 short identifier values. */
function summary(tool: ManagedTool, input: ToolInput): Readonly<Record<string, string>> {
  try {
    const fields = tool.summarize?.(input) ?? {};
    return Object.freeze(Object.fromEntries(Object.entries(fields).slice(0, 8).filter(([key, value]) =>
      /^[a-z][a-z0-9_]{0,31}$/.test(key) && typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value))));
  } catch { return {}; }
}
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new ToolGatewayError("TOOL_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Service-side isolation kernel. Not registered on the legacy Worker or exposed as an HTTP API.
 * Production authority/secret adapters must be installed explicitly; no default credentials. */
export class ToolGateway {
  private active = 0;
  private readonly tools: ReadonlyMap<string, ManagedTool>;
  constructor(private readonly authority: ToolAuthority, private readonly secrets: ToolSecrets,
    tools: ReadonlyMap<string, ManagedTool>, private readonly limits = { concurrent: 5, timeoutMs: 30_000, receiptMs: 5_000 },
    private readonly audit: ToolAudit = () => {}) {
    if (!Number.isSafeInteger(limits.concurrent) || limits.concurrent < 1 || limits.concurrent > 100 ||
        !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 10 || limits.timeoutMs > 120_000 ||
        !Number.isSafeInteger(limits.receiptMs) || limits.receiptMs < 10 || limits.receiptMs > 10_000) throw new Error("Invalid Tool Gateway limits");
    this.tools = new Map(tools);
  }
  async invoke(capability: string, runtime: ToolRuntime, value: unknown, callerSignal = new AbortController().signal): Promise<unknown> {
    if (!opaque(capability) || !runtime || !id(runtime.runtimeId) || !id(runtime.allocationId)) deny("TOOL_IDENTITY_REQUIRED");
    const binding = Object.freeze({ runtimeId: runtime.runtimeId, allocationId: runtime.allocationId });
    const input = parse(value);
    const hash = toolRequestDigest(input);
    if (this.active >= this.limits.concurrent) deny("TOOL_BUSY");
    this.active++;
    // Whether this call holds one of the gateway's slots (released while it waits for the user).
    let holding = true;
    let signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.limits.timeoutMs)]);
    let permit: ToolPermit | undefined;
    let dispatched = false, settling = false;
    let refusal: ToolCallFailed | undefined;
    const started = performance.now();
    let fields: Readonly<Record<string, string>> = {};
    const record = (outcome: ToolAuditEntry["outcome"], code?: string) => {
      try {
        this.audit(Object.freeze({ run: permit?.runId ?? "", tool: input.toolAlias, outcome,
          ...(code ? { code } : {}), ms: Math.round(performance.now() - started), fields }));
      } catch { /* Diagnostics never affect the call. */ }
    };
    try {
      const raw = await bounded(() => this.authority.reserve({ capability, runtime: binding, call: input, requestDigest: hash }, signal), signal);
      const candidate = snapshot(raw, 8000) as ToolPermit;
      check(candidate, input, hash);
      permit = candidate;
      const tool = this.tools.get(permit.serverId);
      if (!tool) throw new ToolGatewayError("TOOL_UNAVAILABLE");
      tool.validate(input, candidate);
      fields = summary(tool, input);
      // Approval bridge: asked before credentials are read, so a call that is not approved never
      // runs. The wait is bounded by the Run's lane and the caller, not by the call timeout,
      // which starts again once the user approved.
      const channel = tool.confirmation ? this.authority.confirmation?.({ capability, runtime: binding }) : undefined;
      if (channel?.operations.length) {
        const request = confirmRequest(tool, input, channel.operations);
        if (request !== undefined) {
          let verdict: ConfirmOutcome = "unavailable";
          if (request) {
            // Waiting for a person must not hold a slot: other calls of this or other Runs go on.
            this.active--;
            holding = false;
            try {
              verdict = await bounded(() => channel.confirm(request, callerSignal), callerSignal);
            } finally {
              // Approved work resumes even if the gateway filled up meanwhile (bounded by the
              // number of Runs waiting at once); refusing it now would waste the user's approval.
              this.active++;
              holding = true;
            }
          }
          if (verdict !== "approved") {
            refusal = new ToolCallFailed(CONFIRMATION_CODES[verdict] ?? CONFIRMATION_CODES.unavailable, true);
            throw refusal;
          }
          signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.limits.timeoutMs)]);
        }
      }
      const credential = await bounded(() => this.secrets.read(candidate, signal,
        Object.freeze({ capability, runtime: binding })), signal);
      const accessToken = credential.accessToken, expiresAt = credential.expiresAt;
      if (typeof accessToken !== "string" || !/^[\x21-\x7e]{32,8192}$/.test(accessToken) ||
          !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) deny("TOOL_CREDENTIAL_UNAVAILABLE");
      await bounded(() => this.authority.dispatch({ capability, runtime: binding, permit: candidate }, signal), signal);
      if (Date.now() >= expiresAt || Date.now() >= permit.expiresAt) deny("TOOL_CREDENTIAL_UNAVAILABLE");
      signal.throwIfAborted();
      dispatched = true;
      const identity = Object.freeze({ tenantId: permit.tenantId, userId: permit.userId,
        actorTenantAccessId: permit.actorTenantAccessId, runId: permit.runId, attributes: permit.attributes,
        serverId: permit.serverId, serverVersion: permit.serverVersion, targetRef: permit.targetRef,
        targetVersion: permit.targetVersion, toolVersion: permit.toolVersion });
      const output = await bounded(() => tool.invoke(input, identity, accessToken, signal,
        Math.min(expiresAt, candidate.expiresAt)), signal);
      let encoded: string | undefined;
      try { encoded = JSON.stringify(output); } catch { deny("TOOL_PROTOCOL"); }
      if (encoded === undefined || encoded.length > 8 * 1024 * 1024) deny("TOOL_PROTOCOL");
      if ([accessToken, capability, permit.receipt].some(s => encoded!.includes(JSON.stringify(s).slice(1, -1)))) deny("TOOL_RESPONSE_REJECTED");
      // The call happened: an oversized result is replaced by a note, never reported as a failure.
      const bytes = Buffer.byteLength(encoded!);
      const result = bytes > RESULT_LIMIT
        ? Object.freeze({ result_omitted: "TOOL_RESULT_TOO_LARGE", bytes, limit: RESULT_LIMIT,
            hint: "The call completed, but its result is too large to return. Request less data (fewer fields, a filter or a smaller page)." })
        : snapshot(output, RESULT_LIMIT);
      settling = true;
      await this.finish(binding, permit, "SUCCEEDED", digest(result));
      record("SUCCEEDED");
      return result;
    } catch (error) {
      // A provider-classified failure after dispatch: definite = the downstream refused it.
      // A call refused for want of approval never ran: a definite failure with its own code.
      const failure = !settling && error instanceof ToolCallFailed && (dispatched || error === refusal) ? error : undefined;
      const outcome = failure?.definite ? "FAILED" : dispatched ? "UNKNOWN" : "FAILED";
      if (permit && !settling) {
        record(outcome, failure?.code);
        await this.finish(binding, permit, outcome, digest({ outcome }));
      } else if (settling) record("UNKNOWN", "TOOL_RECEIPT_UNCONFIRMED");
      else if (permit) record("REJECTED");
      if (failure && !settling) throw new ToolCallFailed(failure.code, failure.definite, failure.reason);
      // Never forward dependency errors containing credentials, payloads, URLs or private policy.
      throw new ToolGatewayError(settling ? "TOOL_RECEIPT_UNCONFIRMED" : dispatched ? "TOOL_RESULT_UNKNOWN" : "TOOL_CALL_REJECTED");
    } finally { if (holding) this.active--; }
  }
  private async finish(runtime: ToolRuntime, permit: ToolPermit, outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN", resultDigest: string): Promise<void> {
    const signal = AbortSignal.timeout(this.limits.receiptMs);
    try { await bounded(() => this.authority.finish({ runtime, permit, outcome, resultDigest }, signal), signal); }
    catch { throw new ToolGatewayError("TOOL_RECEIPT_UNCONFIRMED"); }
  }
}
