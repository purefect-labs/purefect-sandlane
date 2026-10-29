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
/** Engine <-> Worker execution contract (purefect-ai-execution/1).
 * The JSON Schema in contract/ai-execution-v1.schema.json is authoritative; this module only
 * validates what the Worker reads (shape only; Engine stays authoritative for state), including
 * the Engine's numeric ID format. Credentials parsed here live in runtime memory only. */
import { isIdentifier, isObject } from "../../common/json.js";
import {
  ControlPlaneError,
  FAULT_COMPLETE_REJECTED,
  FAULT_EVENT_OFFSET_GAP,
  FAULT_EXECUTION_DISABLED,
  FAULT_INVALID_INPUT,
  FAULT_LEASE_LOST,
  FAULT_OUTPUT_LIMIT,
  REASONING_EFFORTS,
  RUN_SOURCE_TYPES,
  type ClaimedLease,
  type CompleteResult,
  type ExpiringSecret,
  type Lease,
  type LeaseFile,
  type LeaseProof,
  type OutputResult,
  type RunSource,
  type SyncResponse
} from "../../spi/control-plane.js";
import type { ModelWire } from "../../spi/model-upstream.js";
import { WEB_ACCESS_OFF, type WebAccessPolicy } from "../../spi/web-access.js";
import { builtinHarnessWires } from "../../common/builtin-harness.js";

export const EXECUTION_PROTOCOL = "purefect-ai-execution/1";

const ID = /^[0-9]{1,19}$/;
/** Identity attribute keys this plugin's tool adapter reads back (RunIdentity.attributes). */
export const TENANT_CODE = "tenant_code";
export const SITE = "site";
/** Engine fault codes mapped onto the neutral codes the lane acts on. These are definite
 * verdicts; other `ai_*` faults are definite too and keep their own code. */
const FAULTS: Readonly<Record<string, string>> = Object.freeze({
  ai_lease_lost: FAULT_LEASE_LOST,
  ai_event_offset_gap: FAULT_EVENT_OFFSET_GAP,
  ai_complete_rejected: FAULT_COMPLETE_REJECTED,
  ai_invalid_input: FAULT_INVALID_INPUT,
  ai_execution_disabled: FAULT_EXECUTION_DISABLED,
  ai_output_limit: FAULT_OUTPUT_LIMIT
});

/** Error for an Engine fault envelope: `ai_*` business faults are definite rejections. */
export function faultError(fault: string, expected?: number): ControlPlaneError {
  return fault.startsWith("ai_")
    ? new ControlPlaneError("CONTROL_PLANE_REJECTED", FAULTS[fault] ?? fault, expected)
    : new ControlPlaneError("CONTROL_PLANE_FAULT", fault, expected);
}
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
/** Harness of a Run without `run.harness` (older Engine snapshots). */
export const DEFAULT_HARNESS = "codex";
/** Model API each Harness this plugin knows speaks; the lease's model service must match it. */
const HARNESS_WIRES: Readonly<Record<string, ModelWire>> = builtinHarnessWires();

/** Host name pattern of `run.web_access.allowed_domains` (lower case, at least two labels). */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function invalid(): never {
  throw new ControlPlaneError("CONTROL_PLANE_PROTOCOL");
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function id(value: unknown): string {
  return typeof value === "string" && ID.test(value) ? value : invalid();
}
function int(value: unknown, min = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= min ? Number(value) : invalid();
}
function text(value: unknown, maxBytes = 1_000_000): string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes ? value : invalid();
}
function secret(value: unknown): ExpiringSecret {
  const v = object(value);
  const token = text(v.value, 16384);
  if (!token) invalid();
  return Object.freeze({ value: token, expires_at: int(v.expires_at, 1) });
}
function plain(value: unknown): Readonly<Record<string, unknown>> {
  // Detach from the transport object; nested data is copied, never shared.
  return Object.freeze(JSON.parse(JSON.stringify(object(value))) as Record<string, unknown>);
}

export function isClaimToken(value: unknown): value is string {
  return typeof value === "string" && CLAIM_TOKEN.test(value);
}

/** Proof only: enough to settle a lease whose remaining content the Worker rejects. */
export function parseLeaseProof(value: unknown, claimToken: string): LeaseProof | undefined {
  if (!isObject(value) || !isClaimToken(claimToken)) return undefined;
  if (typeof value.job_id !== "string" || !ID.test(value.job_id)) return undefined;
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1) return undefined;
  return Object.freeze({
    job_id: value.job_id,
    generation: Number(value.generation),
    claim_token: claimToken
  });
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T;
}

/** Receives the code of lease content the parser tolerated instead of rejecting the lease. */
export type LeaseAdjusted = (code: string) => void;

/** `run.source`: absent or null (older Engines) means no source, and no delegation tool is offered.
 * A type the Worker does not know (a newer Engine) also means no source, so the Run still runs
 * without delegation tools; only a source that is not an object rejects the lease. `ref` may be
 * absent or null; a ref that is not one bounded line of text is dropped (the Worker never reads
 * it). */
export function parseRunSource(
  value: unknown,
  adjusted: LeaseAdjusted = () => {}
): RunSource | undefined {
  if (value === undefined || value === null) return undefined;
  const v = object(value);
  if (typeof v.type !== "string" || !(RUN_SOURCE_TYPES as readonly string[]).includes(v.type)) {
    adjusted("source_type_unknown");
    return undefined;
  }
  const type = v.type as RunSource["type"];
  if (v.ref === undefined || v.ref === null) return Object.freeze({ type });
  if (
    typeof v.ref !== "string" ||
    !v.ref ||
    v.ref.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(v.ref)
  ) {
    adjusted("source_ref_invalid");
    return Object.freeze({ type });
  }
  return Object.freeze({ type, ref: v.ref });
}

/** Mentions the Worker keeps (the platform's own limit); further ones are dropped. */
const MAX_MENTIONS = 10;
const MENTION_NAME_MAX = 128;

/** `run.web_access` as a neutral policy: open = any site; otherwise the allowed domains (with
 * subdomains), none of them = off. An absent grant (older Engines) means no web access. */
export function parseWebAccess(value: unknown): WebAccessPolicy {
  if (value === undefined || value === null) return WEB_ACCESS_OFF;
  const v = object(value);
  // Platform serialization omits empty lists, as with `history`.
  const allowed = v.allowed_domains === undefined ? [] : v.allowed_domains;
  if (typeof v.open !== "boolean" || !Array.isArray(allowed)) invalid();
  if (allowed.length > 100) invalid();
  const domains = allowed.map(domain =>
    typeof domain === "string" && domain.length <= 253 && DOMAIN.test(domain) ? domain : invalid()
  );
  if (v.open) return Object.freeze({ mode: "open", domains: Object.freeze([]) });
  if (!domains.length) return WEB_ACCESS_OFF;
  return Object.freeze({ mode: "allowlist", domains: Object.freeze([...new Set(domains)]) });
}

/** Pattern of a tool name in `run.tools`. */
const RUN_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** `run.tools`: the tools the platform allows this Run (member settings); absent = no narrowing. */
export function parseRunTools(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some(tool => typeof tool !== "string" || !RUN_TOOL.test(tool))
  )
    invalid();
  return Object.freeze([...new Set(value as string[])]);
}

/** Pattern of `run.confirm_api_codes`: API code characters plus the `*` wildcard. */
const CONFIRM_PATTERN = /^[A-Za-z0-9_.:*-]{1,200}$/;

/** `run.confirm_api_codes` as the neutral confirm policy (patterns the Purefect tools match API
 * codes against). Absent, null or empty = no call needs confirmation; platform serialization
 * omits empty lists. */
export function parseConfirmApiCodes(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 200) invalid();
  const codes = value.map(code =>
    typeof code === "string" && CONFIRM_PATTERN.test(code) ? code : invalid()
  );
  return Object.freeze([...new Set(codes)]);
}

/** File record ID format of the platform's file storage. */
const FILE_ID = /^[A-Za-z0-9-]{1,64}$/;
/** The Engine lists at most this many bindings of a conversation; longer lists are invalid. */
const MAX_LEASE_FILES = 200;
/** Entries kept for the manifest (newest first); older ones are dropped. */
const MAX_STAGED_FILES = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** `credentials.files`: the conversation's files with signed URLs for those to load. Invalid
 * entries reject the whole lease like any other credential (the Run settles as an invalid lease);
 * errors never carry the URLs. Entries beyond the newest MAX_STAGED_FILES are dropped. */
export function parseLeaseFiles(value: unknown): readonly LeaseFile[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LEASE_FILES) invalid();
  const seen = new Set<string>();
  const files = value.map((item): LeaseFile => {
    const f = object(item);
    const fileId = typeof f.file_id === "string" && FILE_ID.test(f.file_id) ? f.file_id : invalid();
    if (seen.has(fileId)) invalid();
    seen.add(fileId);
    const name = text(f.name, 2048);
    if (!name || name.length > 512) invalid();
    const contentType =
      f.content_type === undefined || f.content_type === null
        ? undefined
        : text(f.content_type, 255);
    const size = f.size === undefined || f.size === null ? undefined : int(f.size);
    if (size !== undefined && size > MAX_FILE_BYTES) invalid();
    const relation = oneOf(f.relation, ["input", "output"] as const);
    if (typeof f.loaded !== "boolean") invalid();
    // A file that is not loaded is only named: whatever URL it might carry is not kept.
    let signed: { url: string; expires_at: number } | undefined;
    if (f.loaded) {
      const url = text(f.url, 8192);
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) invalid();
      signed = { url, expires_at: int(f.expires_at, 1) };
    }
    return Object.freeze({
      file_id: fileId,
      name,
      ...(contentType ? { content_type: contentType } : {}),
      ...(size !== undefined ? { size } : {}),
      relation,
      loaded: f.loaded,
      ...signed
    });
  });
  return Object.freeze(files.slice(0, MAX_STAGED_FILES));
}

/** `adjusted` receives the codes of content tolerated rather than rejected (see ClaimedLease). */
export function parseLease(value: unknown, adjusted: LeaseAdjusted = () => {}): Lease {
  const v = object(value);
  const run = object(v.run);
  const identity = object(run.identity);
  const input = object(run.input);
  const credentials = object(v.credentials);
  const model = object(credentials.model_service);
  if (run.execution_profile !== "sandbox") invalid();
  const harness =
    run.harness === undefined || run.harness === null ? DEFAULT_HARNESS : text(run.harness, 32);
  // An unknown Harness, or a model service of another wire, can never run.
  if (!Object.hasOwn(HARNESS_WIRES, harness) || model.wire_api !== HARNESS_WIRES[harness])
    invalid();
  const baseUri = text(model.base_uri, 2048);
  if (!/^https:\/\//.test(baseUri)) invalid();
  const history = (input.history === undefined ? [] : input.history) as unknown;
  if (!Array.isArray(history) || history.length > 10_000) invalid();
  const messages = history.map(item => {
    const m = object(item);
    if (m.role !== "user" && m.role !== "assistant") invalid();
    return Object.freeze({ role: m.role, content: text(m.content) });
  });
  const uiContext =
    input.ui_context === undefined || input.ui_context === null
      ? undefined
      : plain(input.ui_context);
  const instructions =
    input.instructions === undefined || input.instructions === null
      ? undefined
      : text(input.instructions, 64_000);
  // Platform serialization omits empty lists, as with `history`.
  // A longer list is truncated and a missing name becomes empty: mentions only help the model
  // resolve "@name", so neither is worth failing the Run for.
  const rawMentions = input.mentions === undefined || input.mentions === null ? [] : input.mentions;
  if (!Array.isArray(rawMentions)) invalid();
  if (rawMentions.length > MAX_MENTIONS) adjusted("mentions_truncated");
  const mentions = (rawMentions as unknown[]).slice(0, MAX_MENTIONS).map(item => {
    const m = object(item);
    if (m.is_digital !== undefined && typeof m.is_digital !== "boolean") invalid();
    const name = typeof m.name === "string" ? m.name.slice(0, MENTION_NAME_MAX) : "";
    if (!name) adjusted("mention_name_missing");
    return Object.freeze({
      member_id: id(m.member_id),
      name,
      ...(m.is_digital === undefined ? {} : { is_digital: m.is_digital as boolean })
    });
  });
  const runNo = run.run_no === undefined || run.run_no === null ? undefined : int(run.run_no, 1);
  const digest = text(run.input_digest, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) invalid();
  const confirm = parseConfirmApiCodes(run.confirm_api_codes);
  const tools = parseRunTools(run.tools);
  const site = text(identity.site, 128);
  const tenantCode = text(identity.tenant_code, 128);
  if (!site || !tenantCode) invalid();
  const files = parseLeaseFiles(credentials.files);
  if (
    run.file_tools !== undefined &&
    run.file_tools !== null &&
    typeof run.file_tools !== "boolean"
  )
    invalid();
  const fileTools = typeof run.file_tools === "boolean" ? run.file_tools : undefined;
  const source = parseRunSource(run.source, adjusted);
  return Object.freeze({
    job_id: id(v.job_id),
    generation: int(v.generation, 1),
    lease_until: int(v.lease_until, 1),
    deadline_at: int(v.deadline_at, 1),
    run: Object.freeze({
      run_id: id(run.run_id),
      tenant_id: id(run.tenant_id),
      conversation_id: id(run.conversation_id),
      ...(runNo !== undefined ? { run_no: runNo } : {}),
      execution_profile: "sandbox" as const,
      harness,
      web_access: parseWebAccess(run.web_access),
      ...(tools ? { tools } : {}),
      ...(confirm.length ? { confirm_operations: confirm } : {}),
      ...(fileTools !== undefined ? { file_tools: fileTools } : {}),
      ...(source ? { source } : {}),
      identity: Object.freeze({
        user_id: id(identity.user_id),
        ...(identity.tenant_access_id === undefined || identity.tenant_access_id === null
          ? {}
          : { tenant_access_id: id(identity.tenant_access_id) }),
        attributes: Object.freeze({ [TENANT_CODE]: tenantCode, [SITE]: site })
      }),
      input: Object.freeze({
        prompt: text(input.prompt),
        history: Object.freeze(messages),
        ...(uiContext ? { ui_context: uiContext } : {}),
        ...(instructions ? { instructions } : {}),
        ...(mentions.length ? { mentions: Object.freeze(mentions) } : {})
      }),
      input_digest: digest
    }),
    credentials: Object.freeze({
      agent_token: secret(credentials.agent_token),
      model_service: Object.freeze({
        base_uri: baseUri,
        wire_api: HARNESS_WIRES[harness]!,
        model: text(model.model, 256),
        ...(model.reasoning_effort === undefined || model.reasoning_effort === null
          ? {}
          : { reasoning_effort: oneOf(model.reasoning_effort, REASONING_EFFORTS) }),
        api_key: text(model.api_key, 8192)
      }),
      ...(files?.length ? { files } : {})
    })
  });
}

/** ControlPlane.readLease over this contract. */
export function readLease(raw: unknown, claimToken: string): ClaimedLease | undefined {
  const proof = parseLeaseProof(raw, claimToken);
  if (!proof) return undefined;
  const adjustments = new Set<string>();
  try {
    const lease = parseLease(raw, code => adjustments.add(code));
    return Object.freeze({
      proof,
      lease,
      ...(adjustments.size ? { adjustments: Object.freeze([...adjustments]) } : {})
    });
  } catch {
    return Object.freeze({ proof });
  }
}

export function parseClaimResponse(value: unknown): readonly unknown[] {
  const v = object(value);
  if (v.protocol !== EXECUTION_PROTOCOL) invalid();
  // Platform serialization may omit an empty list.
  if (v.leases === undefined || v.leases === null) return Object.freeze([]);
  if (!Array.isArray(v.leases) || v.leases.length > 10) invalid();
  return Object.freeze([...v.leases]);
}

export function parseSyncResponse(value: unknown): SyncResponse {
  const v = object(value);
  if (v.protocol !== EXECUTION_PROTOCOL || typeof v.cancel !== "boolean") invalid();
  const raw =
    v.action_receipts === undefined || v.action_receipts === null ? [] : v.action_receipts;
  if (!Array.isArray(raw) || raw.length > 64) invalid();
  const receipts = raw.map(item => {
    const r = object(item);
    if (!isIdentifier(r.action_id) || (r.status !== "SETTLED" && r.status !== "VOID")) invalid();
    return Object.freeze({
      action_id: r.action_id,
      status: r.status,
      ...(r.receipt !== undefined && r.receipt !== null ? { receipt: plain(r.receipt) } : {})
    });
  });
  // The token may be omitted only with cancel=true (Run subject lost access, see the schema).
  const token =
    v.agent_token === undefined || v.agent_token === null ? undefined : secret(v.agent_token);
  if (!token && v.cancel !== true) invalid();
  return Object.freeze({
    lease_until: int(v.lease_until, 1),
    cancel: v.cancel,
    event_offset: int(v.event_offset),
    action_receipts: Object.freeze(receipts),
    ...(token ? { agent_token: token } : {})
  });
}

/** `output` response: `{protocol}` for a rejected report, plus the stored file otherwise. */
export function parseOutputResponse(value: unknown): OutputResult {
  const v = object(value);
  if (v.protocol !== EXECUTION_PROTOCOL) invalid();
  if (v.file_id === undefined || v.file_id === null) return Object.freeze({});
  const fileId = text(v.file_id, 64);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(fileId)) invalid();
  return Object.freeze({
    file_id: fileId,
    ...(typeof v.name === "string" ? { name: text(v.name, 1024) } : {}),
    ...(typeof v.content_type === "string" ? { content_type: text(v.content_type, 255) } : {}),
    ...(v.size !== undefined && v.size !== null ? { size: int(v.size) } : {})
  });
}

/** `propose` request: lease proof, idempotency key and tool arguments (`ExecutionDomain::propose`). */
export interface ProposeRequest extends LeaseProof {
  /** Unique per tool call, unchanged when the same call is resent (`$defs/identifier`). */
  readonly request_id: string;
  readonly assignee_member_id: string;
  readonly title: string;
  readonly description?: string;
  /** Due time: a 13-digit millisecond timestamp, or `yyyy-MM-dd HH:mm` (read in the server's time
   * zone by the platform). */
  readonly due_at?: number | string;
  readonly review_required?: boolean;
  /** Scheduled or recurring task (a suggestion card whatever the assignee; confirmed, it becomes a
   * plan). Times as with due_at; see task-schedule.ts for the rules. */
  readonly trigger_type?: "once" | "recurring" | "mail";
  readonly run_at?: number | string;
  readonly repeat_rule?: string;
  readonly time_of_day?: string;
  readonly weekdays?: string;
  readonly month_days?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly end_at?: number | string;
  readonly max_runs?: number;
  /** Mail-triggered task (trigger_type mail; see task-mail.ts): the sender whitelist, never empty.
   * The execution mode is not part of the request: the platform fixes it to confirm first. */
  readonly mail_senders?: readonly string[];
  readonly mail_subject_contains?: string;
  readonly mail_folder?: string;
  readonly poll_minutes?: number;
}

/** `propose` result: a digital employee assignee is dispatched (`task_id`); a person gets a
 * suggestion card in the conversation awaiting the user (`proposal_id`, `<run_id>:<request_id>`). */
export type ProposeResult =
  | { readonly result: "dispatched"; readonly task_id: string }
  | {
      readonly result: "proposed";
      readonly proposal_id: string;
      /** Scheduled or recurring proposal: its first run (milliseconds). */
      readonly next_fire_at?: number;
      /** Mail-triggered proposal: the address of the mailbox the plan will watch. */
      readonly mailbox_email?: string;
    };

const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
/** An address as the platform stores it: one token with an @, no spaces, quotes or controls. */
const MAILBOX = /^[^\s"'<>@\u0000-\u001f\u007f]{1,64}@[A-Za-z0-9.-]{1,189}$/;

export function parseProposeResponse(value: unknown): ProposeResult {
  const v = object(value);
  if (v.protocol !== EXECUTION_PROTOCOL) invalid();
  if (v.result === "dispatched")
    return Object.freeze({ result: "dispatched", task_id: id(v.task_id) });
  if (
    v.result === "proposed" &&
    typeof v.proposal_id === "string" &&
    PROPOSAL_ID.test(v.proposal_id)
  )
    return Object.freeze({
      result: "proposed",
      proposal_id: v.proposal_id,
      ...(v.next_fire_at === undefined || v.next_fire_at === null
        ? {}
        : { next_fire_at: int(v.next_fire_at, 1) }),
      // Only shown to the model: an unreadable address is dropped, it does not void the proposal.
      ...(typeof v.mailbox_email === "string" && MAILBOX.test(v.mailbox_email)
        ? { mailbox_email: v.mailbox_email }
        : {})
    });
  return invalid();
}

export function parseCompleteResponse(value: unknown): CompleteResult {
  const v = object(value);
  if (
    v.protocol !== EXECUTION_PROTOCOL ||
    !["ACCEPTED", "ALREADY_ACCEPTED", "ACCEPTED_AS_CANCELLED"].includes(String(v.result))
  )
    invalid();
  return v.result as CompleteResult;
}
