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
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ControlPlaneError,
  type ControlPlane,
  type ClaimRequest,
  type ClaimedLease,
  type Lease,
  type LeaseProof,
  type SyncRequest,
  type SyncResponse,
  type CompleteRequest,
  type CompleteResult,
  type Outcome,
  type ModelService,
  type WorkerEvent
} from "../../spi/control-plane.js";
import { WEB_ACCESS_OFF } from "../../spi/web-access.js";
import {
  BUILTIN_HARNESS_METADATA,
  isBuiltinHarness,
  type BuiltinHarnessId
} from "../../common/builtin-harness.js";

type State = "QUEUED" | "LEASED" | "RUNNING" | Outcome["status"];
interface Job {
  lease: Lease;
  state: State;
  proof?: LeaseProof;
  snapshot?: Lease;
  events: WorkerEvent[];
  eventBytes: number;
  cancel: boolean;
  outcome?: Outcome;
  submittedOutcome?: string;
}
export interface DemoControlOptions {
  readonly model: ModelService;
  readonly harness: BuiltinHarnessId;
  readonly leaseMs?: number;
  readonly deadlineMs?: number;
}
export interface DemoRunView {
  readonly id: string;
  readonly state: State;
  readonly events: readonly WorkerEvent[];
  readonly outcome?: Outcome;
}
const fault = (code: string, expected?: number): never => {
  throw new ControlPlaneError("CONTROL_PLANE_REJECTED", code, expected);
};
const terminal = (state: State) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(state);

/** Bounded, single-process reference control plane. No persistence, automatic replay, HTTP API
 * or business authorization. Identity, model routing and tool grants come only from trusted config. */
export class InMemoryControlPlane implements ControlPlane {
  readonly #jobs = new Map<string, Job>();
  readonly #leaseMs: number;
  readonly #deadlineMs: number;
  readonly #model: ModelService;
  readonly #stop = new AbortController();
  constructor(private readonly options: DemoControlOptions) {
    this.#leaseMs = options.leaseMs ?? 15_000;
    this.#deadlineMs = options.deadlineMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#leaseMs) ||
      this.#leaseMs < 100 ||
      this.#leaseMs > 30_000 ||
      !Number.isSafeInteger(this.#deadlineMs) ||
      this.#deadlineMs < this.#leaseMs ||
      this.#deadlineMs > 600_000 ||
      !isBuiltinHarness(options.harness) ||
      options.model.wire_api !== BUILTIN_HARNESS_METADATA[options.harness].wire ||
      !options.model.api_key ||
      !options.model.model
    )
      throw new Error("INVALID_DEMO_CONFIGURATION");
    const uri = new URL(options.model.base_uri);
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.search || uri.hash)
      throw new Error("INVALID_DEMO_MODEL_ORIGIN");
    this.#model = Object.freeze({ ...options.model });
  }
  submit(prompt: string): string {
    if (this.#stop.signal.aborted) throw new Error("DEMO_CLOSED");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 16_384)
      throw new Error("DEMO_PROMPT_LIMIT");
    if (this.#jobs.size >= 16) throw new Error("DEMO_RUN_LIMIT");
    const id = String(this.#jobs.size + 1),
      now = Date.now();
    const input = { prompt, history: [] };
    this.#jobs.set(id, {
      state: "QUEUED",
      events: [],
      eventBytes: 0,
      cancel: false,
      lease: {
        job_id: id,
        generation: 1,
        lease_until: 0,
        deadline_at: now + this.#deadlineMs,
        run: {
          run_id: id,
          conversation_id: id,
          tenant_id: "demo",
          execution_profile: "sandbox",
          harness: this.options.harness,
          web_access: WEB_ACCESS_OFF,
          tools: ["demo_echo"],
          identity: { user_id: "demo", attributes: {} },
          input,
          input_digest: createHash("sha256").update(JSON.stringify(input)).digest("hex")
        },
        credentials: { agent_token: { value: "", expires_at: 0 }, model_service: this.#model }
      }
    });
    return id;
  }
  #expire(job: Job): void {
    if (terminal(job.state)) return;
    if (Date.now() >= job.lease.deadline_at || (job.proof && Date.now() >= job.lease.lease_until)) {
      job.state = "FAILED";
      job.outcome = {
        status: "FAILED",
        error: { code: "lease_lost", message: "Demo lease expired" }
      };
    }
  }
  #renew(job: Job): void {
    const until = Math.min(Date.now() + this.#leaseMs, job.lease.deadline_at);
    job.lease = {
      ...job.lease,
      lease_until: until,
      credentials: {
        model_service: this.#model,
        agent_token: { value: randomBytes(32).toString("base64url"), expires_at: until }
      }
    };
  }
  async claim(request: ClaimRequest, signal: AbortSignal): Promise<readonly unknown[]> {
    const combined = AbortSignal.any([signal, this.#stop.signal]);
    combined.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.claim_token) || !request.lanes.includes("demo"))
      return fault("invalid_input");
    const until = Date.now() + Math.min(request.wait_ms ?? 0, 25_000);
    do {
      combined.throwIfAborted();
      for (const job of this.#jobs.values()) {
        this.#expire(job);
        if (job.proof?.claim_token === request.claim_token) return [structuredClone(job.snapshot)];
      }
      const job = [...this.#jobs.values()].find(value => value.state === "QUEUED");
      if (job) {
        this.#renew(job);
        job.proof = {
          job_id: job.lease.job_id,
          generation: job.lease.generation,
          claim_token: request.claim_token
        };
        job.state = "LEASED";
        job.snapshot = structuredClone(job.lease);
        return [structuredClone(job.snapshot)];
      }
      if (Date.now() >= until) return [];
      await delay(Math.min(25, Math.max(1, until - Date.now())), undefined, { signal: combined });
    } while (true);
  }
  readLease(raw: unknown, claimToken: string): ClaimedLease | undefined {
    if (!raw || typeof raw !== "object" || !("job_id" in raw) || typeof raw.job_id !== "string")
      return;
    const job = this.#jobs.get(raw.job_id);
    if (
      !job?.proof ||
      job.proof.claim_token !== claimToken ||
      JSON.stringify(raw) !== JSON.stringify(job.snapshot)
    )
      return;
    return { proof: { ...job.proof }, lease: structuredClone(job.snapshot!) };
  }
  #get(proof: LeaseProof, allowComplete = false): Job {
    const job = this.#jobs.get(proof.job_id);
    if (
      !job ||
      !job.proof ||
      job.proof.claim_token !== proof.claim_token ||
      job.proof.generation !== proof.generation
    )
      return fault("lease_lost");
    this.#expire(job);
    if (terminal(job.state) && !(allowComplete && job.submittedOutcome !== undefined))
      return fault("lease_lost");
    return job;
  }
  async sync(request: SyncRequest, signal: AbortSignal): Promise<SyncResponse> {
    signal.throwIfAborted();
    const job = this.#get(request);
    const events = request.events ?? [],
      offset = request.offset ?? job.events.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.events.length)
      return fault("event_offset_gap", job.events.length);
    const appended: WorkerEvent[] = [];
    let bytes = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!,
        encoded = JSON.stringify(event);
      if (offset + i < job.events.length) {
        if (encoded !== JSON.stringify(job.events[offset + i])) return fault("invalid_input");
      } else {
        if (Buffer.byteLength(encoded) > 16_384) return fault("invalid_input");
        bytes += Buffer.byteLength(encoded);
        appended.push(structuredClone(event));
      }
    }
    if (job.events.length + appended.length > 1024 || job.eventBytes + bytes > 1_048_576)
      return fault("invalid_input");
    job.events.push(...appended);
    job.eventBytes += bytes;
    if (request.started) job.state = "RUNNING";
    this.#renew(job);
    return {
      lease_until: job.lease.lease_until,
      event_offset: job.events.length,
      cancel: job.cancel,
      action_receipts: [],
      agent_token: { ...job.lease.credentials.agent_token }
    };
  }
  async complete(request: CompleteRequest, signal: AbortSignal): Promise<CompleteResult> {
    signal.throwIfAborted();
    const job = this.#get(request, true),
      encoded = JSON.stringify(request.outcome);
    if (job.submittedOutcome !== undefined) {
      if (encoded !== job.submittedOutcome) return fault("complete_rejected");
      return "ALREADY_ACCEPTED";
    }
    if (
      !["SUCCEEDED", "FAILED", "CANCELLED"].includes(request.outcome.status) ||
      Buffer.byteLength(request.outcome.answer ?? "") > 200_000
    )
      return fault("invalid_input");
    job.submittedOutcome = encoded;
    job.outcome = structuredClone(
      job.cancel ? { ...request.outcome, status: "CANCELLED" } : request.outcome
    );
    job.state = job.outcome.status;
    return job.cancel ? "ACCEPTED_AS_CANCELLED" : "ACCEPTED";
  }
  cancel(id: string): void {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("DEMO_RUN_UNKNOWN");
    this.#expire(job);
    if (terminal(job.state)) return;
    job.cancel = true;
    if (job.state === "QUEUED") {
      job.state = "CANCELLED";
      job.outcome = { status: "CANCELLED" };
    }
  }
  /** Explicit fixture fault injection: stop renewing the lease, never reuse its proof. */
  expire(id: string): void {
    const job = this.#jobs.get(id);
    if (!job?.proof) throw new Error("DEMO_RUN_NOT_CLAIMED");
    job.lease = { ...job.lease, lease_until: Date.now() - 1 };
    this.#expire(job);
  }
  view(id: string): DemoRunView {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("DEMO_RUN_UNKNOWN");
    this.#expire(job);
    return structuredClone({
      id,
      state: job.state,
      events: job.events,
      ...(job.outcome ? { outcome: job.outcome } : {})
    });
  }
  close(): void {
    this.#stop.abort();
    this.#jobs.clear();
  }
}
