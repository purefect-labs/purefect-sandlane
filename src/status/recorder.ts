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
import { createHmac, randomBytes } from "node:crypto";
import type { LaneState, RunSettlement, StatusEvent, StatusObserver } from "../spi/status.js";

/** How Run identifiers appear: as they are, as a per-process keyed short hash (not reversible
 * from small numeric IDs, not comparable across restarts), or as a sequence number only. */
export type RunIdMode = "plain" | "hash" | "none";

/** Driver and lane phases shown per Run (first occurrence each), in display order. */
export const RUN_PHASES = Object.freeze([
  "claimed",
  "sandbox-ready",
  "started-acked",
  "turn-admitted",
  "first-text",
  "first-delta-synced",
  "turn-ended"
] as const);
const PHASES: ReadonlySet<string> = new Set(RUN_PHASES);

export interface StatusRecorderOptions {
  /** Control plane queues the lanes claim from. */
  readonly queues: readonly string[];
  /** Number of execution lanes. */
  readonly concurrency: number;
  /** Finished Runs kept (ring buffer), 1..500; default 50. */
  readonly recentRuns?: number;
  readonly runIds?: RunIdMode;
  /** Concurrent call limits of the gateways, shown beside their in-flight counts. */
  readonly limits?: { readonly model?: number; readonly tool?: number };
  /** Wall clock in ms; default Date.now. */
  readonly now?: () => number;
}

interface LaneRecord {
  state: LaneState;
  since: number;
  run: RunRecord | undefined;
  error: string | undefined;
}

interface RunRecord {
  readonly id: string;
  readonly harness: string;
  readonly lane: number | undefined;
  readonly startedAt: number;
  readonly phases: Partial<Record<string, number>>;
  status: "running" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  settlement: RunSettlement | undefined;
  error: string | undefined;
  endedAt: number | undefined;
  toolCalls: number;
  toolFailures: number;
}

interface GatewayRecord {
  calls: number;
  failed: number;
  inFlight: number;
  readonly errors: Map<string, number>;
}

/** Bounded set of error codes per gateway; further codes are counted as OTHER. */
const MAX_ERROR_CODES = 16;
/** Active Runs tracked at most (well above the 16-lane ceiling). */
const MAX_ACTIVE = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Error codes (e.g. harness_failure, MODEL_GATEWAY_BUSY:429, ECONNRESET): word characters
 * only, optionally with an HTTP status, so free text never passes as a code. */
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}(?::[0-9]{3})?$/;

const code = (value: unknown): string | undefined =>
  typeof value === "string" && CODE.test(value)
    ? value
    : value === undefined
      ? undefined
      : "INVALID";
const ms = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e10
    ? Math.round(value)
    : undefined;
const iso = (at: number | undefined) => (at === undefined ? undefined : new Date(at).toISOString());

/** Fixed error code of a thrown gateway error: its `code` (or identifier message), plus the HTTP
 * status when it carries one. Never its message text. */
export function errorCodeOf(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown; status?: unknown } | undefined;
  const base =
    typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
      ? value.code
      : typeof value?.message === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.message)
        ? value.message
        : "UNEXPECTED";
  const status = value?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? `${base}:${status}`
    : base;
}

/**
 * In-memory status of one Worker: lanes, active and recent Runs, gateway counters and upstream
 * preconnects. Every update is O(1) and never throws; finished Runs live in a fixed-size ring
 * buffer. Raw Run identifiers are only kept as lookup keys of active Runs, never in a snapshot.
 */
export class StatusRecorder {
  readonly #now: () => number;
  readonly #mode: RunIdMode;
  readonly #key = randomBytes(32);
  readonly #queues: readonly string[];
  readonly #lanes: LaneRecord[];
  readonly #active = new Map<string, RunRecord>();
  readonly #recent: (RunRecord | undefined)[];
  #head = 0;
  #sequence = 0;
  readonly #gateways: Record<"model" | "tool", GatewayRecord>;
  readonly #limits: { readonly model?: number; readonly tool?: number };
  readonly #upstream = {
    preconnects: 0,
    failures: 0,
    last: undefined as
      | { ok: boolean; at: number; elapsedMs: number | undefined; error: string | undefined }
      | undefined
  };

  constructor(options: StatusRecorderOptions) {
    const recent = options.recentRuns ?? 50;
    if (
      !Number.isSafeInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 64 ||
      !Number.isSafeInteger(recent) ||
      recent < 1 ||
      recent > 500 ||
      !["plain", "hash", "none", undefined].includes(options.runIds)
    )
      throw new Error("INVALID_STATUS_CONFIGURATION");
    this.#now = options.now ?? Date.now;
    this.#mode = options.runIds ?? "hash";
    this.#queues = Object.freeze(options.queues.filter(q => IDENTIFIER.test(q)).slice(0, 64));
    const now = this.#now();
    this.#lanes = Array.from({ length: options.concurrency }, () => ({
      state: "idle" as LaneState,
      since: now,
      run: undefined,
      error: undefined
    }));
    this.#recent = new Array<RunRecord | undefined>(recent).fill(undefined);
    const gateway = (): GatewayRecord => ({ calls: 0, failed: 0, inFlight: 0, errors: new Map() });
    this.#gateways = { model: gateway(), tool: gateway() };
    this.#limits = Object.freeze({ ...options.limits });
  }

  /** Observer for one lane: its lane and Run events are attributed to `index`. */
  lane(index: number): StatusObserver {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#lanes.length)
      throw new Error("INVALID_STATUS_LANE");
    return event => this.observe(event, index);
  }

  /** Record one event. Malformed events are ignored; diagnostics never affect execution. */
  readonly observe = (event: StatusEvent, lane?: number): void => {
    try {
      this.#apply(event, lane);
    } catch {
      /* Status never affects execution. */
    }
  };

  /** Track one gateway call: in flight until `work` settles, then counted by outcome. */
  async track<T>(gateway: "model" | "tool", work: () => Promise<T>): Promise<T> {
    this.observe({ type: "gateway.start", gateway });
    try {
      const result = await work();
      this.observe({ type: "gateway.end", gateway, ok: true });
      return result;
    } catch (error) {
      this.observe({ type: "gateway.end", gateway, ok: false, error: errorCodeOf(error) });
      throw error;
    }
  }

  #apply(event: StatusEvent, laneIndex: number | undefined): void {
    const now = this.#now();
    const lane = laneIndex === undefined ? undefined : this.#lanes[laneIndex];
    switch (event.type) {
      case "lane": {
        if (!lane || !["idle", "claiming", "running", "stopped"].includes(event.state)) return;
        // A claim error stays visible until a claim succeeds: claiming again straight after
        // claiming means the previous claim returned; a Run start clears it as well.
        if (event.state === "idle" && event.error !== undefined) lane.error = code(event.error);
        else if (
          event.state === "running" ||
          (event.state === "claiming" && lane.state === "claiming")
        )
          lane.error = undefined;
        if (lane.state !== event.state) lane.since = now;
        lane.state = event.state;
        if (event.state !== "running") lane.run = undefined;
        return;
      }
      case "run.started": {
        if (typeof event.run !== "string" || !event.run) return;
        if (this.#active.size >= MAX_ACTIVE) {
          // Runs whose end was never observed: retire the oldest.
          const [oldest] = this.#active.keys();
          this.#finish(oldest!, undefined, now);
        }
        const record: RunRecord = {
          id: this.#display(event.run),
          harness: IDENTIFIER.test(event.harness) ? event.harness : "unknown",
          lane: laneIndex,
          startedAt: now,
          phases: {},
          status: "running",
          settlement: undefined,
          error: undefined,
          endedAt: undefined,
          toolCalls: 0,
          toolFailures: 0
        };
        this.#active.set(event.run, record);
        if (lane) {
          if (lane.state !== "running") lane.since = now;
          lane.state = "running";
          lane.run = record;
          lane.error = undefined;
        }
        return;
      }
      case "run.phase": {
        const record = this.#active.get(event.run);
        const elapsed = ms(event.elapsedMs);
        if (!record || !PHASES.has(event.phase) || elapsed === undefined) return;
        record.phases[event.phase] ??= elapsed;
        return;
      }
      case "run.tool": {
        const record = this.#active.get(event.run);
        if (!record) return;
        record.toolCalls++;
        if (event.ok !== true) record.toolFailures++;
        return;
      }
      case "run.ended": {
        this.#finish(event.run, event, now);
        return;
      }
      case "gateway.start":
      case "gateway.end": {
        const gateway = Object.hasOwn(this.#gateways, event.gateway)
          ? this.#gateways[event.gateway]
          : undefined;
        if (!gateway) return;
        if (event.type === "gateway.start") {
          gateway.calls++;
          gateway.inFlight++;
          return;
        }
        gateway.inFlight = Math.max(0, gateway.inFlight - 1);
        if (event.ok === true) return;
        gateway.failed++;
        let error = code(event.error) ?? "UNEXPECTED";
        if (!gateway.errors.has(error) && gateway.errors.size >= MAX_ERROR_CODES) error = "OTHER";
        gateway.errors.set(error, (gateway.errors.get(error) ?? 0) + 1);
        return;
      }
      case "upstream.preconnect": {
        const ok = event.ok === true;
        if (ok) this.#upstream.preconnects++;
        else this.#upstream.failures++;
        this.#upstream.last = {
          ok,
          at: now,
          elapsedMs: ms(event.elapsedMs),
          error: ok ? undefined : (code(event.error) ?? "UNEXPECTED")
        };
        return;
      }
    }
  }

  #finish(
    run: string,
    event: Extract<StatusEvent, { type: "run.ended" }> | undefined,
    now: number
  ): void {
    const record = this.#active.get(run);
    if (!record) return;
    this.#active.delete(run);
    const statuses = ["SUCCEEDED", "FAILED", "CANCELLED"];
    record.status = event && statuses.includes(event.status) ? event.status : "FAILED";
    record.settlement =
      event && ["settled", "rejected", "lost", "withheld"].includes(event.settlement)
        ? event.settlement
        : undefined;
    record.error = event ? code(event.error) : "STATUS_UNOBSERVED";
    record.endedAt = now;
    this.#recent[this.#head] = record;
    this.#head = (this.#head + 1) % this.#recent.length;
    for (const lane of this.#lanes)
      if (lane.run === record) {
        lane.run = undefined;
        lane.state = "idle";
        lane.since = now;
      }
  }

  #display(run: string): string {
    const sequence = ++this.#sequence;
    if (this.#mode === "plain" && IDENTIFIER.test(run)) return run;
    if (this.#mode === "none") return `#${sequence}`;
    return createHmac("sha256", this.#key).update(run).digest("hex").slice(0, 12);
  }

  /** Plain JSON view: the only data that leaves the recorder. */
  snapshot(): StatusSnapshot {
    const now = this.#now();
    const run = (record: RunRecord): RunView => ({
      id: record.id,
      harness: record.harness,
      ...(record.lane !== undefined ? { lane: record.lane } : {}),
      startedAt: iso(record.startedAt)!,
      phases: Object.fromEntries(
        RUN_PHASES.filter(phase => record.phases[phase] !== undefined).map(phase => [
          phase,
          record.phases[phase]!
        ])
      ),
      durationMs: (record.endedAt ?? now) - record.startedAt,
      status: record.status,
      ...(record.settlement ? { settlement: record.settlement } : {}),
      ...(record.error ? { error: record.error } : {}),
      toolCalls: record.toolCalls,
      toolFailures: record.toolFailures
    });
    const recent: RunView[] = [];
    for (let i = 1; i <= this.#recent.length; i++) {
      const record = this.#recent[(this.#head - i + this.#recent.length) % this.#recent.length];
      if (record) recent.push(run(record));
    }
    const gateway = (name: "model" | "tool"): GatewayView => {
      const value = this.#gateways[name];
      const limit = this.#limits[name];
      return {
        calls: value.calls,
        failed: value.failed,
        inFlight: value.inFlight,
        ...(limit !== undefined ? { limit } : {}),
        errors: Object.fromEntries(value.errors)
      };
    };
    const last = this.#upstream.last;
    return {
      lanes: {
        queues: [...this.#queues],
        concurrency: this.#lanes.length,
        busy: this.#lanes.filter(lane => lane.state === "running").length,
        items: this.#lanes.map((lane, index) => ({
          index,
          state: lane.state,
          since: iso(lane.since)!,
          ...(lane.run ? { run: lane.run.id } : {}),
          ...(lane.error ? { lastError: lane.error } : {})
        }))
      },
      runs: {
        idMode: this.#mode,
        capacity: this.#recent.length,
        active: [...this.#active.values()].map(run),
        recent
      },
      gateways: { model: gateway("model"), tool: gateway("tool") },
      upstream: {
        preconnects: this.#upstream.preconnects,
        failures: this.#upstream.failures,
        ...(last
          ? {
              last: {
                ok: last.ok,
                at: iso(last.at)!,
                ...(last.elapsedMs !== undefined ? { elapsedMs: last.elapsedMs } : {}),
                ...(last.error ? { error: last.error } : {})
              }
            }
          : {})
      }
    };
  }
}

export interface RunView {
  readonly id: string;
  readonly harness: string;
  readonly lane?: number;
  readonly startedAt: string;
  /** ms since the claim returned, per phase reached. */
  readonly phases: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly status: "running" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly settlement?: RunSettlement;
  readonly error?: string;
  readonly toolCalls: number;
  readonly toolFailures: number;
}

export interface GatewayView {
  readonly calls: number;
  readonly failed: number;
  readonly inFlight: number;
  readonly limit?: number;
  readonly errors: Readonly<Record<string, number>>;
}

export interface StatusSnapshot {
  readonly lanes: {
    readonly queues: readonly string[];
    readonly concurrency: number;
    readonly busy: number;
    readonly items: readonly {
      readonly index: number;
      readonly state: LaneState;
      readonly since: string;
      readonly run?: string;
      readonly lastError?: string;
    }[];
  };
  readonly runs: {
    readonly idMode: RunIdMode;
    readonly capacity: number;
    readonly active: readonly RunView[];
    readonly recent: readonly RunView[];
  };
  readonly gateways: { readonly model: GatewayView; readonly tool: GatewayView };
  readonly upstream: {
    readonly preconnects: number;
    readonly failures: number;
    readonly last?: {
      readonly ok: boolean;
      readonly at: string;
      readonly elapsedMs?: number;
      readonly error?: string;
    };
  };
}
