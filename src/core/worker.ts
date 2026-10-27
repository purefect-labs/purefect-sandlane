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
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isIdentifier } from "../common/json.js";
import type { ContextProvider, TurnContext } from "../spi/context.js";
import {
  ControlPlaneError,
  FAULT_COMPLETE_REJECTED,
  FAULT_EVENT_OFFSET_GAP,
  FAULT_EXECUTION_DISABLED,
  FAULT_INVALID_INPUT,
  FAULT_LEASE_LOST,
  type ActionRequest,
  type ClientActionOffer,
  type ClientConfirmation,
  type ControlPlane,
  type ControlToolOffer,
  type ControlToolResult,
  type Lease,
  type LeaseProof,
  type Outcome,
  type ReasoningEffort,
  type SyncResponse,
  type WorkerEvent
} from "../spi/control-plane.js";
import {
  HARNESS_UNAVAILABLE,
  INPUTS_UNAVAILABLE,
  type SandboxProvider,
  type SandboxSession
} from "../spi/sandbox.js";
import type { RunSettlement, StatusEvent, StatusObserver } from "../spi/status.js";
import type { ConfirmOutcome, ConfirmRequest } from "../spi/tool-provider.js";
import type { AdmissionVerdict } from "./admission.js";
import type { RunCredential, RunCredentialRegistry } from "./credentials.js";
import { stageInputFiles, type StagedInputs } from "./input-files.js";
import { deliverOutputs } from "./output-files.js";
import { ManagedCliExecution } from "./managed-cli-execution.js";
import { FrozenInputContext } from "./turn-input.js";

export type LaneLog = (code: string, fields?: Readonly<Record<string, string | number>>) => void;

export interface LaneOptions {
  readonly runtimeId: string;
  /** Engine queue lanes to claim from (contract `lanes`). */
  readonly lanes: readonly string[];
  /** Tool gateway tools a Run may use; the control plane's client action is offered (per turn)
   * only when its name is listed; so are the control plane tools (offered per lease). */
  readonly enabledTools: readonly string[];
  /** Model name the CLI is configured with; the gateway maps it to the Run's upstream model.
   * A deployment-chosen alias keeps the CLI's request shape stable regardless of the upstream
   * model (the CLI changes how it sends tools for models it recognizes). */
  readonly modelAlias?: string;
  /** Name under which the CLI registers the tool gateway; the model sees tools in this namespace. */
  readonly toolServer?: string;
  /** Development only: accept a sandbox without container isolation. */
  readonly allowLocalSandbox?: boolean;
  readonly claimWaitMs?: number;
  readonly syncIntervalMs?: number;
  readonly actionWaitMs?: number;
  /** Longest wait for one client action receipt, including queueing behind earlier actions. It
   * must stay below the idle timeout of every hop between the CLI and the tool gateway. */
  readonly clientActionTimeoutMs?: number;
  /** Keep-alive sync interval while nothing else syncs (allocation, sandbox stop). */
  readonly heartbeatMs?: number;
  /** First backoff between sandbox stop attempts; doubles per attempt. */
  readonly stopRetryMs?: number;
  /** Hook to validate a Run's upstream before a sandbox is created (e.g. model provider). */
  readonly admit?: (credential: RunCredential) => void;
  /** Builds each turn's input; default: the frozen input without system instructions. */
  readonly context?: ContextProvider;
  /** Sanitized diagnostics only: codes and identifiers, never prompts, output or credentials. */
  readonly log?: LaneLog;
  /** Status recorder of this lane: lane state, Run phases and outcome codes (see spi/status). */
  readonly observe?: StatusObserver;
  /** Checked before each claim; `low` defers the claim (see MemoryAdmission). Absent = always. */
  readonly admission?: { check(): Promise<AdmissionVerdict> };
  /** Wait before checking admission again after `low`. */
  readonly admissionRetryMs?: number;
  /** Sender for conversation file downloads (signed URLs); default global fetch. */
  readonly download?: typeof fetch;
}

const MAX_RUN_MS = 30 * 60_000;
const DELTA_CHUNK = 4_000;
const MAX_EVENTS_PER_SYNC = 200;
/** Throttle between syncs; the Run's first event and its first text are exempt (first feedback). */
const MIN_SYNC_GAP_MS = 100;
const COMPLETE_GRACE_MS = 5_000;
const MAX_CLAIM_BACKOFF_MS = 5_000;
const MAX_STOP_ATTEMPTS = 4;
/** Complete faults that no retry can change. Anything else (transport, protocol, unknown or
 * transient platform faults) is retried until the lease plus grace has passed. */
const TERMINAL_COMPLETE_FAULTS: ReadonlySet<string> = new Set([
  FAULT_COMPLETE_REJECTED,
  FAULT_LEASE_LOST,
  FAULT_INVALID_INPUT
]);
/** A definite control plane verdict on a sync other than these will not change on retry, so the
 * Run fails at once instead of waiting for the lease to lapse. */
const RETRYABLE_SYNC_FAULTS: ReadonlySet<string> = new Set([
  FAULT_LEASE_LOST,
  FAULT_EVENT_OFFSET_GAP,
  FAULT_EXECUTION_DISABLED
]);
/** The Broker cannot renew an allocation before it is running, so allocation must finish within
 * its initial lease (BROKER_INITIAL_LEASE_MS, below the Broker's 60s ceiling). */
const BROKER_INITIAL_LEASE_MS = 55_000;
const OPEN_TIMEOUT_MS = 50_000;
/** Generated files are delivered only while this much of the lease (and the Run's deadline)
 * remains: stopping the sandbox and settling come after them. */
const OUTPUT_MARGIN_MS = 5_000;
/** Longest time spent on generated files per Run (read out, check, report). */
const OUTPUT_PHASE_MS = 120_000;
/** Client actions per Run, and calls queued or running at once (the client runs them serially). */
const MAX_CLIENT_ACTIONS = 64;
const MAX_CLIENT_QUEUE = 4;
/** Events the control plane tools may report per Run, and the bound of one event's data (JSON bytes). */
const MAX_CONTROL_EVENTS = 32;
const CONTROL_EVENT_BYTES = 16 * 1024;
/** Delivery of unconfirmed control plane events after the CLI finished: the longest time spent, the
 * room left before the lease or deadline for settling, and the backoff cap between attempts. */
const CONTROL_FLUSH_MS = 60_000;
const CONTROL_FLUSH_MARGIN_MS = 5_000;
const CONTROL_FLUSH_MAX_BACKOFF_MS = 2_000;
/** Result codes of control plane tools go to the log only: bounded identifiers. */
const CONTROL_RESULT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const failed = (code: string, message: string): Outcome => ({
  status: "FAILED",
  error: { code, message }
});
/** Definite failure: no Driver or CLI image for the lease's Harness on this Worker. */
const harnessUnavailable = (harness: string): Outcome =>
  failed(
    "harness_unavailable",
    /^[a-z][a-z0-9-]{0,31}$/.test(harness)
      ? `The agent harness ${harness} is not available on this Worker`
      : "The agent harness is not available on this Worker"
  );
function faultOf(error: unknown): string | undefined {
  return error instanceof ControlPlaneError ? error.fault : undefined;
}
function errorCode(error: unknown): string {
  if (error instanceof ControlPlaneError) return error.fault ?? error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : "UNEXPECTED";
}
/** Wait for `work`, or reject once `signal` aborts. */
async function abortable(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Tools the lane answers itself: the client action and the control plane tools (neither goes
 * through the tool gateway's authority or the Run owner's token). */
function laneToolNames(control: ControlPlane): string[] {
  return [
    ...(control.clientActions ? [control.clientActions.name] : []),
    ...(control.controlTools ?? []).map(tool => tool.name)
  ];
}

/** File mode of a Run: the control plane's choice, or (older control planes) whether the lease
 * carries conversation files. */
function fileToolsOf(lease: Omit<Lease, "credentials">, secrets: Lease["credentials"]): boolean {
  return lease.run.file_tools ?? !!secrets.files?.length;
}

/** Split on code point boundaries; deltas never contain lone surrogates. */
function chunks(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text) {
    if (current.length + char.length > DELTA_CHUNK) {
      out.push(current);
      current = "";
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** One execution lane: claim -> sandbox -> sync loop -> complete. Run several lanes for
 * concurrency. Only the Engine job is authoritative; nothing is persisted locally, so a crashed
 * Worker never replays a prompt (an expired STARTED lease becomes UNKNOWN on the Engine). */
export class ExecutionLane {
  private draining = false;
  private memoryUnknownLogged = false;
  private readonly drainSignal = new AbortController();
  private readonly options: Required<
    Omit<LaneOptions, "admit" | "log" | "observe" | "allowLocalSandbox" | "admission" | "download">
  > & {
    readonly admit: LaneOptions["admit"] | undefined;
    readonly admission: LaneOptions["admission"] | undefined;
    readonly download: LaneOptions["download"] | undefined;
  };
  private readonly log: LaneLog;
  private readonly observe: StatusObserver;

  constructor(
    private readonly control: ControlPlane,
    private readonly launcher: SandboxProvider,
    private readonly registry: RunCredentialRegistry,
    options: LaneOptions
  ) {
    const claimWaitMs = options.claimWaitMs ?? 25_000;
    const syncIntervalMs = options.syncIntervalMs ?? 1_000;
    const actionWaitMs = options.actionWaitMs ?? 5_000;
    const clientActionTimeoutMs = options.clientActionTimeoutMs ?? 45_000;
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    const stopRetryMs = options.stopRetryMs ?? 1_000;
    const admissionRetryMs = options.admissionRetryMs ?? 2_000;
    const modelAlias = options.modelAlias ?? "sandlane";
    const toolServer = options.toolServer ?? "tools";
    // The client action and control plane tools are answered by the lane, not the tool gateway.
    const laneTools = new Set(laneToolNames(control));
    if (launcher.capabilities.isolation !== "container" && options.allowLocalSandbox !== true)
      throw new Error("SANDBOX_ISOLATION_REQUIRED");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(modelAlias) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(toolServer) ||
      !isIdentifier(options.runtimeId) ||
      !Array.isArray(options.lanes) ||
      options.lanes.length < 1 ||
      options.lanes.length > 8 ||
      !options.lanes.every(isIdentifier) ||
      !Array.isArray(options.enabledTools) ||
      // The client action is offered per turn; at least one tool must always be there.
      !options.enabledTools.some(tool => !laneTools.has(tool)) ||
      !Number.isSafeInteger(claimWaitMs) ||
      claimWaitMs < 0 ||
      claimWaitMs > 25_000 ||
      !Number.isSafeInteger(syncIntervalMs) ||
      syncIntervalMs < 10 ||
      syncIntervalMs > 1_000 ||
      !Number.isSafeInteger(actionWaitMs) ||
      actionWaitMs < 0 ||
      actionWaitMs > 10_000 ||
      !Number.isSafeInteger(clientActionTimeoutMs) ||
      clientActionTimeoutMs < 10 ||
      clientActionTimeoutMs > 55_000 ||
      !Number.isSafeInteger(heartbeatMs) ||
      heartbeatMs < 10 ||
      heartbeatMs > 10_000 ||
      !Number.isSafeInteger(stopRetryMs) ||
      stopRetryMs < 10 ||
      stopRetryMs > 10_000 ||
      !Number.isSafeInteger(admissionRetryMs) ||
      admissionRetryMs < 10 ||
      admissionRetryMs > 60_000
    )
      throw new Error("INVALID_LANE_CONFIGURATION");
    this.options = Object.freeze({
      runtimeId: options.runtimeId,
      lanes: Object.freeze([...options.lanes]),
      enabledTools: Object.freeze([...options.enabledTools]),
      modelAlias,
      toolServer,
      claimWaitMs,
      syncIntervalMs,
      actionWaitMs,
      clientActionTimeoutMs,
      heartbeatMs,
      stopRetryMs,
      admissionRetryMs,
      admit: options.admit,
      admission: options.admission,
      download: options.download,
      context: options.context ?? new FrozenInputContext()
    });
    const log = options.log ?? (() => {});
    this.log = (code, fields) => {
      try {
        log(code, fields);
      } catch {
        /* Diagnostics never affect execution. */
      }
    };
    const observe = options.observe ?? (() => {});
    this.observe = event => {
      try {
        observe(event);
      } catch {
        /* Status never affects execution. */
      }
    };
  }

  /** Stop claiming; a Run already in progress continues to completion. */
  drain(): void {
    this.draining = true;
    this.drainSignal.abort();
  }

  /** Claim loop. `signal` aborts in-progress work too (cancels execution, still cleans up). */
  async run(signal: AbortSignal): Promise<void> {
    let token = randomBytes(32).toString("base64url");
    let backoff = 1_000;
    let deferred = false;
    while (!signal.aborted && !this.draining) {
      if (!(await this.admitted(deferred))) {
        deferred = true;
        await delay(this.options.admissionRetryMs, undefined, {
          signal: AbortSignal.any([signal, this.drainSignal.signal])
        }).catch(() => {});
        continue;
      }
      deferred = false;
      let leases: readonly unknown[];
      this.observe({ type: "lane", state: "claiming" });
      const claimSent = performance.now();
      try {
        leases = await this.control.claim(
          {
            runtime_id: this.options.runtimeId,
            lanes: this.options.lanes,
            claim_token: token,
            max_jobs: 1,
            wait_ms: this.options.claimWaitMs
          },
          AbortSignal.any([signal, this.drainSignal.signal])
        );
        backoff = 1_000;
      } catch (error) {
        if (signal.aborted || this.draining) break;
        // Keep the same claim token: a lost response returns the same jobs on retry.
        this.log("CLAIM_RETRY", { error: errorCode(error) });
        this.observe({ type: "lane", state: "idle", error: errorCode(error) });
        // Short cap: an idle lane must notice a recovered Engine quickly. Jitter spreads lanes.
        const wait = Math.round(backoff / 2 + (Math.random() * backoff) / 2);
        await delay(wait, undefined, { signal }).catch(() => {});
        backoff = Math.min(backoff * 2, MAX_CLAIM_BACKOFF_MS);
        continue;
      }
      const claimedAt = performance.now();
      const claimed = { at: claimedAt, ms: Math.round(claimedAt - claimSent) };
      const used = token;
      token = randomBytes(32).toString("base64url");
      for (const raw of leases) await this.execute(raw, used, signal, claimed);
    }
    this.observe({ type: "lane", state: "stopped" });
  }

  /** Memory admission before a claim. A waiting lane logs its deferral once and an unreadable
   * host is logged once per lane, so polling does not flood the logs. */
  private async admitted(deferred: boolean): Promise<boolean> {
    const admission = this.options.admission;
    if (!admission) return true;
    let verdict: AdmissionVerdict;
    try {
      verdict = await admission.check();
    } catch {
      verdict = "unknown";
    }
    if (verdict === "low") {
      if (!deferred) this.log("CLAIM_DEFERRED", { reason: "memory" });
      this.observe({ type: "lane", state: "idle", error: "MEMORY_LOW" });
      return false;
    }
    if (verdict === "unknown" && !this.memoryUnknownLogged) {
      this.memoryUnknownLogged = true;
      this.log("ADMISSION_MEMORY_UNKNOWN");
    }
    return true;
  }

  /** Execute one claimed lease to completion. Exposed for tests and single-shot use.
   * `claimed.at` (performance.now() when the claim returned) is the Run's TIMING origin;
   * `claimed.ms` is the claim round trip including the Engine's long-poll wait. */
  async execute(
    raw: unknown,
    claimToken: string,
    signal: AbortSignal,
    claimed: Claimed = { at: performance.now(), ms: 0 }
  ): Promise<void> {
    const read = this.control.readLease(raw, claimToken);
    if (!read) {
      this.log("LEASE_REJECTED");
      return;
    }
    const { proof, lease } = read;
    for (const adjustment of read.adjustments ?? [])
      if (isIdentifier(adjustment)) this.log("LEASE_ADJUSTED", { job: proof.job_id, adjustment });
    if (!lease) {
      this.log("LEASE_REJECTED", { job: proof.job_id });
      await this.complete(
        proof,
        failed("worker_invalid_lease", "The Worker rejected the lease content"),
        Date.now() + 30_000
      );
      return;
    }
    // Raw credentials go to the registry only; the Run keeps the non-secret lease content.
    const { credentials, ...run } = lease;
    await new RunExecution(this, run, credentials, proof, signal, claimed).run();
  }

  /** @internal */
  get settings() {
    return this.options;
  }
  /** @internal */
  get deps() {
    return {
      control: this.control,
      launcher: this.launcher,
      registry: this.registry,
      log: this.log,
      observe: this.observe
    };
  }

  /** Retry delivery until accepted, rejected or the lease is clearly gone. Identical retries
   * are acknowledged as ALREADY_ACCEPTED by the Engine. */
  async complete(proof: LeaseProof, outcome: Outcome, notAfter: number): Promise<boolean> {
    let backoff = 250;
    for (;;) {
      try {
        const result = await this.control.complete(
          { ...proof, outcome },
          AbortSignal.timeout(15_000)
        );
        this.log("RUN_COMPLETED", { job: proof.job_id, status: outcome.status, result });
        return true;
      } catch (error) {
        if (TERMINAL_COMPLETE_FAULTS.has(faultOf(error) ?? "")) {
          this.log("COMPLETE_REJECTED", { job: proof.job_id, error: errorCode(error) });
          return false;
        }
        if (Date.now() + backoff > notAfter + COMPLETE_GRACE_MS) {
          this.log("COMPLETE_ABANDONED", { job: proof.job_id, error: errorCode(error) });
          return false;
        }
        this.log("COMPLETE_RETRY", { job: proof.job_id, error: errorCode(error) });
        await delay(backoff);
        backoff = Math.min(backoff * 2, 4_000);
      }
    }
  }
}

interface Claimed {
  readonly at: number;
  readonly ms: number;
}

interface PendingAction {
  readonly request: ActionRequest;
  requested: boolean;
  resolve(receipt: unknown): void;
  reject(error: Error): void;
}

/** State of one leased Run. */
class RunExecution {
  private readonly control: ControlPlane;
  private readonly launcher: SandboxProvider;
  private readonly registry: RunCredentialRegistry;
  private readonly log: LaneLog;
  private readonly observe: StatusObserver;
  private leaseUntil: number;
  private lost = false;
  /** Definite Engine rejection of a sync (fault code); the Run fails at once. */
  private rejected: string | undefined;
  private cancelRequested = false;
  private cancelling = false;
  private shutdown = false;
  private stopping = false;
  private events: WorkerEvent[] = [];
  private acked = 0;
  /** Events below this index were included in a sync request and must not change any more. */
  private submitted = 0;
  private readonly actions = new Map<string, PendingAction>();
  /** Client actions run one at a time, in call order. */
  private clientQueue: Promise<void> = Promise.resolve();
  private clientQueued = 0;
  private clientCalls = 0;
  /** Events reported by control plane tools so far, and their indexes in `events` (ascending; an
   * index never moves: events are only appended or replaced in place). */
  private controlEvents = 0;
  private readonly controlIndexes: number[] = [];
  private wake = new AbortController();
  /** Raw lease credentials until they are registered; never kept for the Run's lifetime. */
  private secrets: Lease["credentials"] | undefined;
  private credential: RunCredential | undefined;
  private session: SandboxSession | undefined;
  private execution: ManagedCliExecution | undefined;
  /** File mode: the CLI got file and command tools, and its generated files are delivered. */
  private fileTools = false;
  /** Aborted once the generated files are no longer wanted: the Worker ended the CLI itself
   * (cancellation, shutdown, deadline, lost lease, rejected reports), a cancellation arrived
   * while they were being delivered, or the sandbox is stopping. Handed to the sandbox
   * (SandboxRequest.outputsAbandoned), which then neither reads them while the CLI stops nor
   * holds the stop up for a read in progress. */
  private readonly outputsWanted = new AbortController();
  /** Index of the Run's first text delta event, once observed. */
  private firstText: number | undefined;
  private firstTextSynced = false;
  /** Set while the loop waits out the sync gap: re-checks urgency on each Driver event. */
  private throttled: (() => void) | undefined;
  private readonly expiresAt: number;
  private readonly fields: Readonly<Record<string, string>>;
  /** Not a secret: the lane's model choice, kept after the credentials are registered. */
  private readonly reasoningEffort: ReasoningEffort | undefined;

  constructor(
    private readonly lane: ExecutionLane,
    private readonly lease: Omit<Lease, "credentials">,
    secrets: Lease["credentials"],
    private readonly proof: LeaseProof,
    private readonly outer: AbortSignal,
    private readonly claimed: Claimed
  ) {
    ({
      control: this.control,
      launcher: this.launcher,
      registry: this.registry,
      log: this.log,
      observe: this.observe
    } = lane.deps);
    this.secrets = secrets;
    this.reasoningEffort = secrets.model_service.reasoning_effort;
    this.leaseUntil = lease.lease_until;
    this.expiresAt = Math.min(lease.deadline_at, Date.now() + MAX_RUN_MS - 5_000);
    this.fields = Object.freeze({ job: lease.job_id, run: lease.run.run_id });
  }

  async run(): Promise<void> {
    const runId = this.lease.run.run_id;
    this.observe({ type: "run.started", run: runId, harness: this.lease.run.harness });
    this.timing("claimed", { claimMs: this.claimed.ms });
    // Reported once the Run leaves the lane; a failure before settlement counts as rejected.
    let ended: Omit<Extract<StatusEvent, { type: "run.ended" }>, "type" | "run"> = {
      status: "FAILED",
      settlement: "rejected",
      error: "worker_failure"
    };
    const onShutdown = () => {
      this.shutdown = true;
      this.abandonOutputs();
      this.notify();
    };
    this.outer.addEventListener("abort", onShutdown, { once: true });
    try {
      let outcome: Outcome;
      try {
        outcome = await this.drive();
      } catch (error) {
        this.log("RUN_FAILURE", { ...this.fields, error: errorCode(error) });
        outcome = failed("worker_failure", "The Worker failed while executing the Run");
      } finally {
        this.secrets = undefined;
      }
      const result = (settlement: RunSettlement) =>
        (ended = {
          status: outcome.status,
          settlement,
          ...(outcome.error ? { error: outcome.error.code } : {})
        });
      result("rejected");
      // Gateway access ends with execution, not with settlement or a confirmed stop: a sandbox
      // whose stop is still unconfirmed must not reach the model or tools any more.
      this.revoke();
      // Before settlement, so the control plane records the files ahead of the Run's completion.
      // The files were read when the Driver stopped its transport at the end of the CLI's turn
      // (that stop terminates the allocation, emptying the workspace); a Run whose CLI the Worker
      // ended itself has none to deliver.
      await this.deliverOutputs(outcome);
      const stopped = await this.stop();
      const usage = this.credential?.usage;
      // Provider-executed web searches are billed per request; the outcome carries tokens only.
      if (this.credential?.webSearches)
        this.log("WEB_SEARCH_USAGE", { ...this.fields, requests: this.credential.webSearches });
      if (this.lost) {
        // The Engine no longer recognizes this lease: stop only, never complete.
        this.log("LEASE_LOST", this.fields);
        result("lost");
        return;
      }
      if (!stopped) {
        // A terminal result would release the conversation's next Run while the old container may
        // still be running. Let the lease lapse instead: the Engine records UNKNOWN and holds the
        // queue until lease expiry plus its stop grace, by which time the Broker watchdog has
        // stopped the container (its lease is never renewed past the last Engine lease).
        this.log("SETTLEMENT_WITHHELD", this.fields);
        result("withheld");
        return;
      }
      const accepted = await this.lane.complete(
        this.proof,
        usage ? { ...outcome, usage } : outcome,
        this.leaseUntil
      );
      result(accepted ? "settled" : "rejected");
    } finally {
      this.outer.removeEventListener("abort", onShutdown);
      this.rejectActions();
      // Idempotent: also covers failures thrown before the normal revoke point.
      this.revoke();
      this.observe({ type: "run.ended", run: runId, ...ended });
    }
  }

  /** Returns the outcome to report, or sets `lost`. */
  private async drive(): Promise<Outcome> {
    const { lease } = this;
    const secrets = this.secrets!;
    this.secrets = undefined;
    const now = Date.now();
    if (lease.lease_until <= now || this.expiresAt <= now + 1_000) {
      this.markLost();
      return failed("lease_expired", "Lease expired before execution");
    }
    const confirmOperations = Object.freeze([...(lease.run.confirm_operations ?? [])]);
    // Control plane tools are offered per lease, decided before the turn input is built so that
    // the notes and the tool list agree.
    const controls = this.offerControlTools();
    const toolNotes = controls.flatMap(({ offer }) => (offer.note ? [offer.note] : []));
    // A Run nobody can answer (e.g. an assigned task) gets no client action and asks no approval.
    const unattended = this.unattended();
    let turn: TurnContext;
    try {
      turn = await this.lane.settings.context.turn(
        {
          runId: lease.run.run_id,
          conversationId: lease.run.conversation_id,
          tenantId: lease.run.tenant_id,
          userId: lease.run.identity.user_id,
          input: lease.run.input,
          webAccess: lease.run.web_access,
          confirmOperations,
          ...(lease.run.tools ? { tools: lease.run.tools } : {}),
          ...(fileToolsOf(lease, secrets) ? { inputFiles: true } : {}),
          ...(toolNotes.length ? { toolNotes } : {}),
          ...(unattended ? { unattended: true } : {})
        },
        this.outer
      );
    } catch {
      return failed("invalid_input", "The frozen Run input exceeds Worker limits");
    }
    const model = secrets.model_service.model;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(model))
      return failed("model_service_unsupported", "The configured model name is not supported");
    const settings = this.lane.settings;
    const allocationId = `run-${lease.run.run_id}-g${lease.generation}`;
    // The client action is a tool of this Run only: offered from the turn's own context, served by
    // the tool gateway to this Run's capability and relayed through this lane.
    const actions = this.control.clientActions;
    let offer: ClientActionOffer | undefined;
    // The control plane may narrow the Run's tools (member settings); it can never widen them.
    const allowed = (tool: string) =>
      settings.enabledTools.includes(tool) && (!lease.run.tools || lease.run.tools.includes(tool));
    if (actions && allowed(actions.name) && !unattended)
      try {
        offer = actions.offer({ prompt: turn.prompt, promptFormat: turn.promptFormat });
      } catch {
        offer = undefined;
      }
    // The approval bridge exists only when the policy names operations; whether a client can
    // answer this turn is judged from the same envelope (no client: such calls do not run).
    let confirmation: ClientConfirmation | undefined;
    if (confirmOperations.length && actions?.confirmation && !unattended)
      try {
        confirmation = actions.confirmation({
          prompt: turn.prompt,
          promptFormat: turn.promptFormat
        });
      } catch {
        confirmation = undefined;
      }
    const laneTools = new Set(laneToolNames(this.control));
    const gatewayTools = settings.enabledTools.filter(
      tool => !laneTools.has(tool) && allowed(tool)
    );
    const runTools = [
      ...gatewayTools,
      ...(offer ? [actions!.name] : []),
      ...controls.map(control => control.name)
    ];
    // File mode: the Run's conversation files (at least their manifest) go into the workspace,
    // and only then does its CLI get file and command tools (sandbox launch, model gateway
    // functions, Driver policy).
    const fileTools = fileToolsOf(lease, secrets);
    this.fileTools = fileTools;
    this.credential = this.registry.register(
      {
        jobId: lease.job_id,
        generation: lease.generation,
        runId: lease.run.run_id,
        tenantId: lease.run.tenant_id,
        conversationId: lease.run.conversation_id,
        userId: lease.run.identity.user_id,
        tenantAccessId: lease.run.identity.tenant_access_id ?? lease.run.identity.user_id,
        attributes: lease.run.identity.attributes,
        runtime: { runtimeId: settings.runtimeId, allocationId },
        harness: lease.run.harness,
        modelWire: secrets.model_service.wire_api,
        modelAlias: settings.modelAlias,
        providerModel: model,
        baseUri: secrets.model_service.base_uri,
        enabledTools: gatewayTools,
        webAccess: lease.run.web_access,
        ...(fileTools ? { fileTools: true } : {}),
        expiresAt: this.expiresAt
      },
      {
        modelKey: secrets.model_service.api_key,
        agentToken: {
          value: secrets.agent_token.value,
          expiresAt: secrets.agent_token.expires_at
        },
        leaseUntil: lease.lease_until
      },
      offer
        ? {
            name: actions!.name,
            description: offer.description,
            inputSchema: offer.inputSchema,
            call: (args, signal) => this.clientAction(offer, args, signal)
          }
        : undefined,
      confirmOperations.length
        ? {
            operations: confirmOperations,
            confirm: (request, signal) =>
              this.confirmCall(confirmation, request, signal, unattended)
          }
        : undefined,
      controls.map(({ name, offer }) => ({
        name,
        description: offer.description,
        inputSchema: offer.inputSchema,
        call: (args: unknown, signal: AbortSignal, callId?: string) =>
          this.controlToolCall(name, offer, args, signal, callId)
      }))
    );
    try {
      settings.admit?.(this.credential);
    } catch {
      return failed("model_service_unsupported", "The configured model service is not supported");
    }

    const capabilities = this.credential.capabilities();
    // Allocation may take a while (cold image, busy node): keep the lease alive without
    // reporting "started"; nothing has executed yet, so a lost lease simply requeues the job.
    const opening = new AbortController();
    let allocating = true;
    const stopHeartbeat = this.heartbeat(response => {
      if (!allocating) return;
      // Nothing has started yet: a cancellation or a definite rejection ends allocation at once.
      if (response?.cancel) this.cancelRequested = true;
      if (this.lost || this.rejected || this.cancelRequested) opening.abort();
    });
    try {
      // Conversation files are downloaded on the Worker host (the sandbox has no network) before
      // allocation: the Broker lease cannot be renewed until the CLI runs. The signed URLs stay
      // here; only file contents and the manifest go to the sandbox.
      let inputs: StagedInputs | undefined;
      if (fileTools) {
        // Without files (file mode always on) only an empty manifest is written.
        inputs = await stageInputFiles(secrets.files ?? [], {
          signal: AbortSignal.any([this.outer, opening.signal]),
          ...(settings.download ? { send: settings.download } : {}),
          onSkip: (file, error) => this.log("INPUT_FILE_SKIPPED", { ...this.fields, file, error })
        });
        this.log("INPUT_FILES_STAGED", {
          ...this.fields,
          loaded: inputs.loaded,
          unloaded: inputs.unloaded
        });
        this.timing("inputs-downloaded");
      }
      this.session = await this.launcher.open(
        {
          allocationId,
          harness: lease.run.harness,
          tenantId: lease.run.tenant_id,
          runId: lease.run.run_id,
          userId: lease.run.identity.user_id,
          generation: lease.generation,
          conversationId: lease.run.conversation_id,
          expiresAt: this.expiresAt,
          // Not tied to the Engine lease: the heartbeat above keeps the Engine lease alive during
          // allocation, but the Broker lease cannot be renewed until the container runs. Nothing
          // executes before "started", and the Engine's UNKNOWN stop grace covers the difference.
          leaseExpiresAt: Math.min(Date.now() + BROKER_INITIAL_LEASE_MS, this.expiresAt),
          prompt: turn.prompt,
          promptFormat: turn.promptFormat,
          modelAlias: settings.modelAlias,
          toolServer: settings.toolServer,
          enabledTools: runTools,
          modelCapability: capabilities.model,
          toolCapability: capabilities.tool,
          ...(inputs ? { inputs: inputs.files, outputsAbandoned: this.outputsWanted.signal } : {})
        },
        AbortSignal.any([this.outer, opening.signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)])
      );
      this.timing("sandbox-ready");
    } catch (error) {
      const refused = this.refused();
      if (refused) return refused;
      if (this.cancelRequested) return { status: "CANCELLED" };
      if (errorCode(error) === HARNESS_UNAVAILABLE) return harnessUnavailable(lease.run.harness);
      if (errorCode(error) === INPUTS_UNAVAILABLE) {
        this.log("INPUT_FILES_UNAVAILABLE", this.fields);
        return failed(
          "input_files_unavailable",
          "The conversation files could not be placed into the sandbox"
        );
      }
      this.log("SANDBOX_UNAVAILABLE", { ...this.fields, error: errorCode(error) });
      return failed("sandbox_unavailable", "The execution sandbox could not be started");
    } finally {
      allocating = false;
      // An in-flight heartbeat finishes on its own; it must not delay the "started" report.
      stopHeartbeat();
    }
    const refused = this.refused();
    if (refused) return refused;
    if (this.cancelRequested) return { status: "CANCELLED" };

    // Input delivered. The CLI and its thread are prepared while "started" is reported; the
    // model turn (the first model request) waits for the Engine's acknowledgement.
    const session = this.session;
    const driver = session.driver.capabilities;
    // The gateway serves the Run the entry of its lease's wire only: a Driver speaking another
    // wire could never reach the model.
    if (driver.modelWire !== secrets.model_service.wire_api)
      return harnessUnavailable(lease.run.harness);
    session.driver.on("event", () => {
      this.notify();
      // After the execution's own listener (registered later) has taken the event.
      queueMicrotask(() => this.throttled?.());
    });
    let admit = () => {};
    let refuse = () => {};
    const admission = new Promise<void>((resolve, reject) => {
      admit = resolve;
      refuse = () => reject(new Error("RUN_NOT_STARTED"));
    });
    admission.catch(() => {});
    this.execution = new ManagedCliExecution(
      session.driver,
      {
        runId: lease.run.run_id,
        prompt: turn.prompt,
        promptFormat: turn.promptFormat,
        conversationId: lease.run.conversation_id,
        ...(turn.contextData ? { contextData: turn.contextData } : {}),
        ...(turn.instructions ? { instructions: turn.instructions } : {}),
        beforeTurn: () => admission,
        ...(fileTools ? { fileTools: true } : {}),
        expiresAt: this.expiresAt,
        ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
        // Driver phases (driver-start, first-text, ...) share the Run's claim-based clock.
        timingOrigin: this.claimed.at
      },
      () => this.notify()
    );
    let admitted = false;
    try {
      const early = await this.reportStarted();
      if (early) return early;
      admitted = true;
    } finally {
      if (admitted) admit();
      else refuse();
    }
    await this.loop();
    return this.refused() ?? this.outcome();
  }

  /** Report "started" once (idempotent on retry). Returns an outcome when the Run must not
   * proceed to its model turn. */
  private async reportStarted(): Promise<Outcome | undefined> {
    for (;;) {
      if (this.shutdown) return failed("worker_shutdown", "The Worker stopped before execution");
      // Preparation failed before any model request: nothing was executed.
      if (this.execution?.done) return failed("harness_failure", "Agent execution failed");
      const response = await this.sync({ started: true });
      const refused = this.refused();
      if (refused) return refused;
      if (response) {
        if (response.cancel) {
          this.cancelRequested = true;
          this.abandonOutputs();
          return { status: "CANCELLED" };
        }
        this.timing("started-acked");
        return undefined;
      }
      await this.sleep(this.lane.settings.syncIntervalMs);
    }
  }

  private async loop(): Promise<void> {
    const execution = this.execution!;
    let lastSync = 0;
    let flushAttempts = 0;
    let flushBackoff = this.lane.settings.syncIntervalMs;
    let flushUntil: number | undefined;
    for (;;) {
      if (this.lost || this.rejected) {
        this.abandonOutputs();
        await execution.fail().catch(() => {});
        return;
      }
      if ((this.shutdown || Date.now() >= this.expiresAt) && !execution.done && !this.cancelling) {
        this.cancelling = true;
        this.cancelExecution(execution);
      }
      const done = execution.done;
      this.collect();
      const gap = MIN_SYNC_GAP_MS - (Date.now() - lastSync);
      if (gap > 0 && !this.urgent()) await this.throttle(gap);
      lastSync = Date.now();
      const acked = this.acked;
      const response = await this.sync({});
      if (this.lost || this.rejected) continue;
      // A Run that already finished reports its real outcome; the Engine arbitrates the race.
      if (response?.cancel && !this.cancelRequested && !execution.done) {
        this.cancelRequested = true;
        this.cancelling = true;
        this.cancelExecution(execution);
      }
      if (done) {
        // Deliver the backlog (up to MAX_EVENTS_PER_SYNC per sync); give up only after three
        // syncs in a row that made no progress.
        this.collect();
        if (this.acked >= this.events.length) return;
        flushAttempts = this.acked > acked ? 0 : flushAttempts + 1;
        if (flushAttempts < 3) continue;
        if (!this.controlEventPending()) return;
        // Control plane reports (e.g. task results) must reach the Engine before complete: keep
        // resending with backoff while the lease, the Run deadline and the flush budget leave
        // room to settle afterwards.
        flushUntil ??= Date.now() + CONTROL_FLUSH_MS;
        const notAfter =
          Math.min(this.leaseUntil, this.expiresAt, flushUntil) - CONTROL_FLUSH_MARGIN_MS;
        if (Date.now() + flushBackoff > notAfter) {
          this.log("CONTROL_EVENTS_UNDELIVERED", {
            ...this.fields,
            pending: this.events.length - this.acked
          });
          return;
        }
        await this.sleep(flushBackoff);
        flushBackoff = Math.min(flushBackoff * 2, CONTROL_FLUSH_MAX_BACKOFF_MS);
        continue;
      }
      if (!response) {
        await this.sleep(this.lane.settings.syncIntervalMs);
        continue;
      }
      if (this.hasWork()) continue;
      // Waiting on a page action receipt is the sync long poll itself.
      if (this.awaiting().length && this.lane.settings.actionWaitMs > 0) continue;
      await this.sleep(this.lane.settings.syncIntervalMs);
    }
  }

  /** The Worker ends the CLI's turn (cancellation, shutdown or deadline). Gateway access ends
   * first, so nothing in the sandbox reaches the model or tools while the Driver interrupts the
   * CLI and stops it (aborting in-flight calls); the generated files are not read. */
  private cancelExecution(execution: ManagedCliExecution): void {
    this.revoke();
    this.abandonOutputs();
    this.rejectActions();
    void execution.cancel().catch(() => {});
  }

  private outcome(): Outcome {
    const execution = this.execution!;
    const answer = execution.preview ?? "";
    if (execution.truncated) this.log("ANSWER_TRUNCATED", this.fields);
    if (this.shutdown) return failed("worker_shutdown", "The Worker stopped during execution");
    if (this.cancelRequested)
      return answer ? { status: "CANCELLED", answer } : { status: "CANCELLED" };
    const terminal = execution.result?.type;
    if (terminal === "run.completed") return { status: "SUCCEEDED", answer };
    if (Date.now() >= this.expiresAt)
      return failed("deadline_exceeded", "The Run exceeded its deadline");
    return failed("harness_failure", "Agent execution failed");
  }

  /** Outcome once the lease is lost or the Engine definitely rejected the Run's reports. */
  private refused(): Outcome | undefined {
    if (this.lost) return failed("lease_lost", "Lease lost");
    if (this.rejected)
      return failed("sync_rejected", `The Engine rejected the Run's report (${this.rejected})`);
    return undefined;
  }

  /** Append newly observed text deltas and tool-call activity as contiguous events, in order. */
  private collect(): void {
    for (const event of this.execution?.take() ?? []) {
      if (event.type === "message.delta") {
        const text = String(event.data.delta);
        // Coalesce token-sized deltas that no sync has carried yet: fewer event rows and
        // browser renders, same text and order.
        const last = this.events.length - 1;
        const previous = this.events[last];
        if (last >= this.submitted && previous?.type === "assistant.message.delta") {
          const joined = String(previous.data?.delta ?? "") + text;
          if (joined.length <= DELTA_CHUNK) {
            this.events[last] = Object.freeze({
              type: "assistant.message.delta",
              data: Object.freeze({ delta: joined })
            });
            continue;
          }
        }
        this.firstText ??= this.events.length;
        for (const delta of chunks(text))
          this.events.push(
            Object.freeze({ type: "assistant.message.delta", data: Object.freeze({ delta }) })
          );
      } else if (event.type === "item.started" || event.type === "item.completed") {
        this.events.push(
          Object.freeze({
            type: event.type === "item.started" ? "runtime.item.started" : "runtime.item.completed",
            data: Object.freeze({ item: event.data.item })
          })
        );
      }
    }
  }

  /** Unsent events include the Run's first event or its first text: sync without the gap. */
  private urgent(): boolean {
    return (
      this.events.length > this.submitted &&
      (this.submitted === 0 || (this.firstText ?? -1) >= this.submitted)
    );
  }

  /** Wait out the sync gap, ending early once urgent events arrive. Leaves `wake` pending, so a
   * notification during the gap (completion, shutdown) still cuts the next sleep short. */
  private async throttle(ms: number): Promise<void> {
    const early = new AbortController();
    this.throttled = () => {
      this.collect();
      if (this.urgent()) early.abort();
    };
    try {
      await delay(ms, undefined, { signal: early.signal }).catch(() => {});
    } finally {
      this.throttled = undefined;
    }
  }

  private hasWork(): boolean {
    this.collect();
    return (
      this.acked < this.events.length ||
      [...this.actions.values()].some(action => !action.requested)
    );
  }

  private awaiting(): string[] {
    return [...this.actions.values()]
      .filter(action => action.requested)
      .map(action => action.request.action_id)
      .slice(0, 32);
  }

  /** One sync round trip. Returns undefined on a transient failure; sets `lost` when the lease is gone. */
  private async sync(extra: { started?: boolean }): Promise<SyncResponse | undefined> {
    const offset = this.acked;
    const events = this.events.slice(offset, offset + MAX_EVENTS_PER_SYNC);
    this.submitted = Math.max(this.submitted, offset + events.length);
    const requests = [...this.actions.values()].filter(action => !action.requested).slice(0, 8);
    const awaiting = this.awaiting();
    const idle = !events.length && !requests.length && !extra.started;
    const waitMs =
      idle && awaiting.length && !this.execution?.done ? this.lane.settings.actionWaitMs : 0;
    const remaining = this.leaseUntil - Date.now();
    if (remaining <= 0) {
      this.markLost();
      return undefined;
    }
    let response: SyncResponse;
    try {
      response = await this.control.sync(
        {
          ...this.proof,
          ...(extra.started ? { started: true } : {}),
          ...(events.length ? { offset, events } : {}),
          ...(requests.length ? { action_requests: requests.map(action => action.request) } : {}),
          ...(awaiting.length ? { awaiting_actions: awaiting } : {}),
          ...(waitMs ? { wait_ms: waitMs } : {})
        },
        AbortSignal.timeout(Math.max(1, Math.min(remaining, waitMs + 15_000)))
      );
    } catch (error) {
      const fault = faultOf(error);
      if (fault === FAULT_LEASE_LOST) {
        this.markLost();
        return undefined;
      }
      if (fault === FAULT_EVENT_OFFSET_GAP && error instanceof ControlPlaneError) {
        // Resend from the Engine's expected offset; never skip ahead of what was produced.
        const expected = error.expected ?? 0;
        this.acked = Math.max(0, Math.min(expected, this.events.length));
        this.log("EVENT_OFFSET_GAP", { ...this.fields, expected });
        return undefined;
      }
      if (
        error instanceof ControlPlaneError &&
        error.code === "CONTROL_PLANE_REJECTED" &&
        fault &&
        !RETRYABLE_SYNC_FAULTS.has(fault)
      ) {
        // e.g. invalid input: resending the same report cannot succeed.
        if (!this.rejected) this.log("SYNC_REJECTED", { ...this.fields, error: fault });
        this.rejected ??= fault;
        this.notify();
        return undefined;
      }
      if (Date.now() >= this.leaseUntil) this.markLost();
      this.log("SYNC_RETRY", { ...this.fields, error: errorCode(error) });
      return undefined;
    }
    this.leaseUntil = response.lease_until;
    this.acked = Math.max(0, Math.min(response.event_offset, this.events.length));
    if (!this.firstTextSynced && this.firstText !== undefined && this.acked > this.firstText) {
      this.firstTextSynced = true;
      this.timing("first-delta-synced");
    }
    for (const action of requests) action.requested = true;
    this.credential?.renew(
      response.lease_until,
      response.agent_token && {
        value: response.agent_token.value,
        expiresAt: response.agent_token.expires_at
      }
    );
    // While stopping, only the Engine lease is kept: the sandbox lease must be allowed to lapse
    // so the Broker watchdog still ends a container whose stop stays unconfirmed.
    if (!this.stopping)
      void this.session
        ?.renew(response.lease_until, AbortSignal.timeout(10_000))
        .catch(error =>
          this.log("SANDBOX_RENEW_FAILED", { ...this.fields, error: errorCode(error) })
        );
    for (const receipt of response.action_receipts) {
      const action = this.actions.get(receipt.action_id);
      if (!action) continue;
      this.actions.delete(receipt.action_id);
      action.resolve(
        receipt.status === "SETTLED" && receipt.receipt
          ? { ...receipt.receipt, actionId: receipt.receipt.actionId ?? receipt.action_id }
          : this.control.clientActions?.failure(
              receipt.action_id,
              "unavailable",
              "Workspace action was voided"
            )
      );
    }
    return response;
  }

  /** Tool gateway bridge for one client action call: check the arguments, wait for earlier
   * actions, relay the request through sync and return the checked receipt. Every outcome is a
   * receipt the model can read. */
  private async clientAction(
    offer: ClientActionOffer,
    args: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const actions = this.control.clientActions!;
    const actionId = `act_${randomUUID()}`;
    let problem: string | null;
    try {
      problem = offer.checkArguments(args);
    } catch {
      problem = "invalid arguments";
    }
    if (problem !== null) return actions.failure(actionId, "invalid_argument", problem);
    const op = (args as Record<string, unknown>).op;
    const result = await this.serially(
      {
        actionId,
        op: typeof op === "string" ? op : "",
        arguments: args as Record<string, unknown>
      },
      signal
    );
    if (result === "busy")
      return actions.failure(
        actionId,
        "invalid_argument",
        "Too many workspace actions; call them one at a time"
      );
    if (result === "timeout" || result === "unavailable")
      return actions.failure(actionId, result, "Workspace action did not complete");
    try {
      return actions.checkReceipt(actionId, result.receipt);
    } catch {
      this.log("CLIENT_ACTION_RECEIPT_INVALID", this.fields);
      return actions.failure(actionId, "unavailable", "The client returned an invalid receipt");
    }
  }

  /** Approval bridge for one tool call: asks the user's client through the same channel and queue
   * as page actions and returns the verdict. No client this turn, a full queue, or a void or
   * invalid receipt: unavailable; no answer within the action timeout: timeout; an unattended Run:
   * unattended at once. Never rejects. */
  private async confirmCall(
    confirmation: ClientConfirmation | undefined,
    request: ConfirmRequest,
    signal: AbortSignal,
    unattended: boolean
  ): Promise<ConfirmOutcome> {
    let outcome: ConfirmOutcome = unattended ? "unattended" : "unavailable";
    try {
      // Nobody could answer: refused at once, nothing is relayed.
      if (unattended || !confirmation) return outcome;
      const actionId = `act_${randomUUID()}`;
      const action = confirmation.request(request);
      const result = await this.serially(
        { actionId, op: action.op, arguments: action.arguments },
        signal
      );
      if (result === "timeout") outcome = "timeout";
      else if (result !== "busy" && result !== "unavailable") {
        const verdict = confirmation.verdict(actionId, result.receipt);
        if (verdict === "approved" || verdict === "rejected" || verdict === "timeout")
          outcome = verdict;
      }
      return outcome;
    } catch {
      return outcome;
    } finally {
      this.log("TOOL_CONFIRMATION", {
        ...this.fields,
        tool: isIdentifier(request?.tool) ? request.tool : "unknown",
        outcome
      });
    }
  }

  /** Relay one client action after every earlier one (the client runs them one at a time), with
   * the client action timeout covering queueing and the wait for the receipt. */
  private async serially(
    request: { actionId: string; op: string; arguments: Readonly<Record<string, unknown>> },
    signal: AbortSignal
  ): Promise<{ receipt: unknown } | "busy" | "timeout" | "unavailable"> {
    if (this.clientCalls >= MAX_CLIENT_ACTIONS || this.clientQueued >= MAX_CLIENT_QUEUE)
      return "busy";
    this.clientCalls++;
    this.clientQueued++;
    const timer = AbortSignal.timeout(this.lane.settings.clientActionTimeoutMs);
    const deadline = AbortSignal.any([signal, timer]);
    const previous = this.clientQueue;
    let release = () => {};
    const own = new Promise<void>(resolve => (release = resolve));
    // The next action waits for this one and for every earlier one, even if this one gives up
    // while still queued.
    this.clientQueue = Promise.all([previous, own]).then(() => {});
    try {
      await abortable(previous, deadline);
      return { receipt: await this.workspaceAction(request, deadline) };
    } catch {
      return timer.aborted ? "timeout" : "unavailable";
    } finally {
      this.clientQueued--;
      release();
    }
  }

  /** Queue an action request for the next sync and wait for its receipt. */
  private workspaceAction(
    request: { actionId: string; op: string; arguments: Readonly<Record<string, unknown>> },
    signal: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const op = request.op;
      if (
        this.lost ||
        this.cancelling ||
        this.cancelRequested ||
        this.stopping ||
        !isIdentifier(request.actionId) ||
        !/^[a-z][a-z_]{0,31}$/.test(op) ||
        this.actions.has(request.actionId) ||
        this.actions.size >= 8
      ) {
        reject(new Error("WORKSPACE_UNAVAILABLE"));
        return;
      }
      const abort = () => {
        this.actions.delete(request.actionId);
        reject(new Error("WORKSPACE_UNAVAILABLE"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.actions.set(request.actionId, {
        request: Object.freeze({
          action_id: request.actionId,
          op,
          arguments: JSON.parse(JSON.stringify(request.arguments)) as Record<string, unknown>
        }),
        requested: false,
        resolve: value => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: error => {
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      });
      this.notify();
    });
  }

  private rejectActions(): void {
    for (const action of this.actions.values()) action.reject(new Error("WORKSPACE_UNAVAILABLE"));
    this.actions.clear();
  }

  /** Whether the control plane says nobody can answer this Run's client actions; a throwing
   * check counts as attended (the behaviour without one). */
  private unattended(): boolean {
    const actions = this.control.clientActions;
    if (!actions?.attended) return false;
    try {
      return !actions.attended(this.lease);
    } catch {
      return false;
    }
  }

  /** The control plane tools offered to this Run: enabled on this Worker (SANDLANE_ENABLED_TOOLS)
   * and offered by the control plane for the lease. The lease's `run.tools` does not narrow them
   * (see ControlTool); an offer that throws counts as not offered. */
  private offerControlTools(): { readonly name: string; readonly offer: ControlToolOffer }[] {
    const offered: { name: string; offer: ControlToolOffer }[] = [];
    for (const tool of this.control.controlTools ?? []) {
      if (!this.lane.settings.enabledTools.includes(tool.name)) continue;
      let offer: ControlToolOffer | undefined;
      try {
        offer = tool.offer(this.lease);
      } catch {
        offer = undefined;
      }
      if (offer) offered.push({ name: tool.name, offer });
    }
    return offered;
  }

  /** One control plane tool call relayed by the tool gateway. The plugin returns its failures as
   * results; an unexpected exception also becomes a failed result for the model and never affects
   * the Run. The log carries the tool, outcome and code only, never arguments or result text. */
  private async controlToolCall(
    name: string,
    offer: ControlToolOffer,
    args: unknown,
    signal: AbortSignal,
    callId: string | undefined
  ): Promise<ControlToolResult> {
    const started = performance.now();
    let result: ControlToolResult;
    try {
      result = await offer.call(
        args,
        Object.freeze({
          proof: this.proof,
          ...(callId !== undefined ? { callId } : {}),
          report: (event: WorkerEvent) => this.reportControlEvent(event),
          signal
        })
      );
    } catch {
      result = { text: "Tool call unavailable; do not automatically retry.", failed: true };
    }
    this.log("CONTROL_TOOL_CALL", {
      ...this.fields,
      tool: name,
      outcome: result.failed ? "FAILED" : "SUCCEEDED",
      ...(result.code && CONTROL_RESULT_CODE.test(result.code) ? { result: result.code } : {}),
      ms: Math.round(performance.now() - started)
    });
    return result;
  }

  /** An event reported by a control plane tool joins the same event queue: the Driver's events
   * produced so far are taken first, keeping the order; it then travels with sync at contiguous
   * offsets. When the CLI has finished, an unconfirmed one is resent with backoff before complete
   * while the lease leaves room (CONTROL_FLUSH_*); only then is it given up and logged. Refused
   * once the Run is ending (CLI exited, sandbox stopping, lease lost or reports definitely
   * rejected), above the size bound, or at the per-Run limit when there is nothing to replace. */
  private reportControlEvent(event: WorkerEvent): boolean {
    if (this.lost || this.rejected || this.stopping || !this.execution || this.execution.done)
      return false;
    let data: Record<string, unknown>;
    try {
      const encoded = JSON.stringify(event.data ?? {});
      if (Buffer.byteLength(encoded) > CONTROL_EVENT_BYTES) return false;
      data = JSON.parse(encoded) as Record<string, unknown>;
    } catch {
      return false;
    }
    this.collect();
    const frozen = Object.freeze({ type: event.type, data: Object.freeze(data) });
    if (this.controlEvents >= MAX_CONTROL_EVENTS) {
      // At the limit, the newest report replaces the last one of its type that no sync has
      // carried yet, so the latest report is the one delivered; otherwise it is refused.
      const index = this.controlIndexes.findLast(
        i => i >= this.submitted && this.events[i]?.type === event.type
      );
      if (index === undefined) return false;
      this.events[index] = frozen;
    } else {
      this.controlIndexes.push(this.events.length);
      this.events.push(frozen);
      this.controlEvents++;
    }
    this.notify();
    return true;
  }

  /** Whether an event reported by a control plane tool is still unconfirmed by the Engine. */
  private controlEventPending(): boolean {
    const last = this.controlIndexes.at(-1);
    return last !== undefined && last >= this.acked;
  }

  /** Take the generated files from the sandbox, check them and report each one (refused ones
   * included) to the control plane. Only for a file-mode Run whose CLI finished its turn on its
   * own (successfully or not), while the lease holds: the sandbox read them when the Driver
   * stopped its transport, which it skips once the Worker ended the CLI itself (cancellation,
   * shutdown, deadline, lost lease; see outputsWanted). The Engine lease is kept alive meanwhile,
   * and a cancellation arriving now ends the delivery after the report in flight. Nothing here
   * changes the Run's outcome, and only codes and counts are logged: never names, contents or
   * URLs. */
  private async deliverOutputs(outcome: Outcome): Promise<void> {
    const session = this.session;
    const control = this.control;
    if (
      !this.fileTools ||
      !session?.outputs ||
      !control.output ||
      !this.execution?.done ||
      outcome.status === "CANCELLED" ||
      this.cancelRequested ||
      this.lost ||
      this.rejected ||
      this.shutdown ||
      this.outputsWanted.signal.aborted
    )
      return;
    const phaseEnd = Date.now() + OUTPUT_PHASE_MS;
    const notAfter = () => Math.min(this.leaseUntil, this.expiresAt, phaseEnd) - OUTPUT_MARGIN_MS;
    if (notAfter() <= Date.now()) {
      this.log("OUTPUT_FILES_SKIPPED", { ...this.fields, reason: "deadline" });
      return;
    }
    // The Run's outcome is already decided (the Engine arbitrates a late cancellation); a cancel
    // now only stops further reports.
    const stopHeartbeat = this.heartbeat(response => {
      if (response?.cancel) this.abandonOutputs();
    });
    const abandoned = this.outputsWanted.signal;
    try {
      const outputs = await session.outputs(
        AbortSignal.any([
          this.outer,
          abandoned,
          AbortSignal.timeout(Math.max(1, notAfter() - Date.now()))
        ])
      );
      this.log("OUTPUT_FILES_COLLECTED", {
        ...this.fields,
        files: outputs.files.length,
        rejected: outputs.rejected.length
      });
      if (!outputs.files.length && !outputs.rejected.length) return;
      const delivery = await deliverOutputs(outputs, {
        send: (report, signal) => control.output!({ ...this.proof, ...report }, signal),
        notAfter,
        stopped: () => this.lost || this.shutdown || abandoned.aborted,
        signal: this.outer,
        log: (code, fields) => this.log(code, { ...this.fields, ...fields })
      });
      this.log("OUTPUT_FILES_DELIVERED", { ...this.fields, ...delivery });
      this.timing("outputs-delivered");
    } catch (error) {
      this.log("OUTPUT_FILES_UNAVAILABLE", { ...this.fields, error: errorCode(error) });
    } finally {
      stopHeartbeat();
    }
  }

  /** Stop the sandbox. Returns whether the stop is confirmed (true when nothing was started). */
  private async stop(): Promise<boolean> {
    this.stopping = true;
    // Delivery is over (or never happened): a CLI still running is not kept alive for a read.
    this.abandonOutputs();
    this.rejectActions();
    if (!this.session) return true;
    const session = this.session;
    // Stopping can take several Broker round trips: keep the Engine lease alive meanwhile, so a
    // confirmed stop can still settle.
    const stopHeartbeat = this.heartbeat();
    let state: "stopped" | "unknown" = "unknown";
    try {
      if (this.execution && !this.execution.done) await this.execution.fail().catch(() => {});
      let backoff = this.lane.settings.stopRetryMs;
      for (let attempt = 1; ; attempt++) {
        state = await session.close().catch(() => "unknown" as const);
        if (
          state === "stopped" ||
          attempt >= MAX_STOP_ATTEMPTS ||
          this.lost ||
          Date.now() + backoff >= this.leaseUntil
        )
          break;
        this.log("SANDBOX_STOP_RETRY", { ...this.fields, attempt });
        await delay(backoff);
        backoff *= 2;
      }
    } finally {
      stopHeartbeat();
    }
    // The Broker watchdog still enforces the last renewed lease; report, do not pretend.
    if (state !== "stopped") this.log("SANDBOX_STOP_UNCONFIRMED", this.fields);
    return state === "stopped";
  }

  /** Keep-alive sync while nothing else syncs. Returns the stop function; a beat already in
   * flight finishes on its own and is never awaited. */
  private heartbeat(after: (response: SyncResponse | undefined) => void = () => {}): () => void {
    let beating = false;
    const timer = setInterval(() => {
      if (beating || this.lost) return;
      beating = true;
      void this.sync({})
        .then(after)
        .catch(() => {})
        .finally(() => {
          beating = false;
        });
    }, this.lane.settings.heartbeatMs);
    return () => clearInterval(timer);
  }

  /** The Engine no longer holds this lease: end gateway access at once (aborting in-flight model
   * and tool calls), then let the loop stop the sandbox. */
  private markLost(): void {
    this.lost = true;
    this.revoke();
    this.abandonOutputs();
    this.notify();
  }

  private revoke(): void {
    if (this.credential) this.registry.revoke(this.credential);
  }

  private abandonOutputs(): void {
    this.outputsWanted.abort();
  }

  private notify(): void {
    this.wake.abort();
  }

  /** Same format and clock as the Driver's TIMING phases: ms since the claim returned. */
  private timing(phase: string, extra?: Readonly<Record<string, number>>): void {
    const elapsedMs = Math.round(performance.now() - this.claimed.at);
    this.log("TIMING", { run: this.lease.run.run_id, phase, elapsedMs, ...extra });
    this.observe({ type: "run.phase", run: this.lease.run.run_id, phase, elapsedMs });
  }

  private async sleep(ms: number): Promise<void> {
    const wake = this.wake;
    if (!wake.signal.aborted) await delay(ms, undefined, { signal: wake.signal }).catch(() => {});
    if (this.wake === wake) this.wake = new AbortController();
  }
}
