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
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BrokerError,
  harnessId,
  identifier,
  object,
  exactKeys,
  parseRef,
  parseRunSpec,
  parseRenewal
} from "./contracts.js";
import type { AllocationRef, RunSpec } from "./contracts.js";
import type { Engine } from "./docker-engine.js";
import type { DockerAttachChannel } from "./docker-attach.js";
import type { HarnessLauncher } from "../../spi/harness.js";
import { RunNetworks } from "./run-network.js";
import { SessionProcesses } from "./session-processes.js";
import { decodeInputs, inputArchive } from "./session-inputs.js";
import {
  LIST_COMMAND,
  LISTING_MAX_BYTES,
  archiveCommand,
  archiveLimit,
  collectOutputs,
  encodeOutputs,
  parseArchive,
  parseListing,
  planOutputs,
  type CollectedOutputs
} from "./session-outputs.js";
import {
  DEFAULT_OUTPUT_LIMITS,
  validOutputLimits,
  type OutputLimits
} from "../../common/output-files.js";
import { parseRelayBinding, type RelayBinding } from "./relay-binding.js";
import {
  parseGatewayPolicy,
  parseRunAuthorization,
  launchDigest,
  managedLaunch,
  type ManagedGatewayPolicy,
  type RunAuthorization
} from "./managed-launch.js";

type State = "allocating" | "running" | "terminated" | "failed";
interface RecordState {
  ref: AllocationRef;
  userId: string;
  digest: string;
  expiresAt: number;
  leaseExpiresAt?: number;
  state: State;
  containerName: string;
  /** Harness ID of the allocation; absent only on cancellation tombstones. */
  harness?: string;
  channelOpened?: true;
  networkMode?: "isolated";
  networkId?: string;
  launchDigest?: string;
  relay?: Readonly<RelayBinding>;
  sessionKey?: string;
  resourceAllocationId?: string;
  resourceDigest?: string;
  idleUntil?: number | undefined;
  stopEvidence?: "process-namespace-stopped";
}
/** One supported Harness: its pinned CLI image and the Driver's launch description. */
export interface BrokerHarness {
  /** Image reference pinned by sha256 digest. */
  image: string;
  /** The Broker starts it without knowing the CLI. */
  launcher: HarnessLauncher;
  /** Container memory limit (MiB, swap included); default DEFAULT_MEMORY_MIB. The workspace
   * tmpfs counts against it. */
  memoryMiB?: number;
}

export interface BrokerConfig {
  nodeId: string;
  /** Harness ID -> CLI image and launch description; a Run names its Harness by ID. */
  harnesses: Readonly<Record<string, BrokerHarness>>;
  stateDir: string;
  maxConcurrent: number;
  perTenant: number;
  /** Reverse-DNS prefix of the Docker labels that mark owned containers, networks and Relays. */
  labelPrefix: string;
  networkMode?: "none" | "isolated";
  relay?: Readonly<RelayBinding>;
  managedGateways?: Readonly<ManagedGatewayPolicy>;
  /** Size of the /workspace tmpfs in MiB (conversation files plus working files); default
   * DEFAULT_WORKSPACE_MIB. Must stay below every Harness's memory limit. */
  workspaceMiB?: number;
  /** Limits of the files read out of a workspace's outputs directory per Run; default
   * DEFAULT_OUTPUT_LIMITS (10 files, 10 MiB each, 30 MiB together). */
  outputLimits?: OutputLimits;
}

const IMAGE_DIGEST = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/;

const STATE_DIR_OPTIONS = "rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700";
export const DEFAULT_WORKSPACE_MIB = 96;
export const DEFAULT_MEMORY_MIB = 512;
const MIB = 1024 * 1024;
/** Upper bound of one input extraction (the Run's files are at most a few tens of MiB). */
const INPUTS_TIMEOUT_MS = 30_000;
/** Upper bound of reading a Run's outputs (listing and archive together). */
const OUTPUTS_TIMEOUT_MS = 30_000;

function validResources(memoryMiB: unknown, workspaceMiB: number): boolean {
  const memory = memoryMiB ?? DEFAULT_MEMORY_MIB;
  return (
    Number.isSafeInteger(memory) &&
    Number(memory) >= 128 &&
    Number(memory) <= 65_536 &&
    Number(memory) > workspaceMiB
  );
}

function validHarness(harness: HarnessLauncher | undefined): boolean {
  const absolute = (value: unknown) =>
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "/" &&
    !value.includes("\0");
  return (
    !!harness &&
    typeof harness.configure === "function" &&
    absolute(harness.command) &&
    Array.isArray(harness.args) &&
    harness.args.every(arg => typeof arg === "string") &&
    Object.entries(harness.env ?? {}).every(
      ([key, value]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(key) && typeof value === "string"
    ) &&
    Array.isArray(harness.stateDirs) &&
    harness.stateDirs.every(absolute)
  );
}

/** Pending creation still reserves capacity, including when cleanup cannot be confirmed. */
function holdsCapacity(record: RecordState): boolean {
  return record.state === "running" || record.state === "allocating";
}

function executionDeadline(record: RecordState): number {
  return Math.min(record.expiresAt, record.leaseExpiresAt ?? record.expiresAt);
}

/** Node-local lifecycle ledger. It is NOT the platform Job/lease authority. */
export class SandboxBroker {
  private records = new Map<string, RecordState>();
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private healthy = true;
  private persistenceFailed = false;
  private queued = 0;
  private readonly config: Readonly<BrokerConfig>;
  private readonly owner: string;
  private readonly networks: RunNetworks;
  private readonly sessionLaunches = new Map<string, ReturnType<typeof managedLaunch>>();
  /** Digest of the inputs written per allocation: a replay is acknowledged, a different set is
   * refused. In memory only: a restart terminates every unstarted allocation anyway. */
  private readonly inputDigests = new Map<string, string>();
  constructor(
    private readonly engine: Engine,
    config: BrokerConfig,
    private readonly clock = Date.now
  ) {
    const harnesses = Object.entries(config.harnesses ?? {});
    const workspaceMiB = config.workspaceMiB ?? DEFAULT_WORKSPACE_MIB;
    // At least the previous fixed 64 MiB: the Run's input files alone may take 40 MiB.
    if (!Number.isSafeInteger(workspaceMiB) || workspaceMiB < 64 || workspaceMiB > 4096)
      throw new Error("Invalid Broker configuration");
    const outputLimits = Object.freeze({ ...(config.outputLimits ?? DEFAULT_OUTPUT_LIMITS) });
    if (!validOutputLimits(outputLimits)) throw new Error("Invalid Broker output limits");
    if (
      harnesses.length < 1 ||
      harnesses.length > 16 ||
      !harnesses.every(
        ([id, harness]) =>
          /^[a-z][a-z0-9-]{0,31}$/.test(id) &&
          IMAGE_DIGEST.test(harness?.image ?? "") &&
          validHarness(harness.launcher)
      )
    )
      throw new Error("Approved image digest and launch description required per harness");
    if (!harnesses.every(([, harness]) => validResources(harness.memoryMiB, workspaceMiB)))
      throw new Error("Harness memory limits must exceed the workspace size");
    this.config = Object.freeze({
      ...config,
      workspaceMiB,
      outputLimits,
      harnesses: Object.freeze(
        Object.fromEntries(
          harnesses.map(([id, { image, launcher, memoryMiB }]) => [
            id,
            Object.freeze({ image, launcher, memoryMiB: memoryMiB ?? DEFAULT_MEMORY_MIB })
          ])
        )
      ),
      ...(config.relay ? { relay: parseRelayBinding(config.relay) } : {}),
      ...(config.managedGateways
        ? { managedGateways: parseGatewayPolicy(config.managedGateways) }
        : {})
    });
    if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(config.labelPrefix ?? ""))
      throw new Error("Invalid Broker label prefix");
    this.owner = `${config.labelPrefix}.broker`;
    this.networks = new RunNetworks(engine, config.nodeId, config.labelPrefix);
    identifier(config.nodeId);
    if (
      !path.isAbsolute(config.stateDir) ||
      !Number.isSafeInteger(config.maxConcurrent) ||
      config.maxConcurrent < 1 ||
      !Number.isSafeInteger(config.perTenant) ||
      config.perTenant < 1 ||
      (config.managedGateways !== undefined && !config.relay) ||
      (config.relay !== undefined && config.networkMode !== "isolated") ||
      (config.networkMode !== undefined && !["none", "isolated"].includes(config.networkMode))
    )
      throw new Error("Invalid Broker configuration");
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    // Admission, ledger updates and cleanup share one bounded queue so capacity checks
    // cannot race. A rejected operation must not poison subsequent reconciliation.
    if (this.queued >= 64)
      return Promise.reject(new BrokerError("BUSY", 429, "Broker operation queue is full"));
    this.queued++;
    const next = this.tail.then(op).finally(() => {
      this.queued--;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  status() {
    const active = [...this.records.values()].filter(holdsCapacity).length;
    return {
      schemaVersion: 1,
      ready: this.ready && this.healthy,
      nodeId: this.config.nodeId,
      active,
      idleSessions: [...this.records.values()].filter(record => record.idleUntil !== undefined)
        .length,
      sessionIdleMs: 300_000,
      capacity: this.config.maxConcurrent,
      perTenant: this.config.perTenant,
      queuedOperations: this.queued,
      network: this.config.networkMode ?? "none",
      fixedRelay: this.config.relay !== undefined,
      harnesses: Object.keys(this.config.harnesses),
      managedLaunch: this.config.managedGateways !== undefined,
      modelAccess: false,
      businessMcp: false
    };
  }

  private async save(record: RecordState): Promise<void> {
    const file = path.join(this.config.stateDir, `${identifier(record.ref.allocationId)}.json`);
    try {
      await writeFile(`${file}.pending`, JSON.stringify(record), { mode: 0o600, flush: true });
      await rename(`${file}.pending`, file);
      // A renewal acknowledgement must survive directory-entry loss as well as file-data loss.
      const directory = await open(this.config.stateDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.records.set(record.ref.allocationId, record);
    } catch (error) {
      // A failed fsync can follow a successful rename. Only restart can reconcile that disk state.
      this.persistenceFailed = true;
      this.healthy = false;
      throw error;
    }
  }

  /** The record's Harness as configured now; a Harness removed from the configuration cannot
   * start or continue a CLI. */
  private harnessOf(record: RecordState): BrokerHarness {
    const harness =
      record.harness !== undefined && Object.hasOwn(this.config.harnesses, record.harness)
        ? this.config.harnesses[record.harness]
        : undefined;
    if (!harness)
      throw new BrokerError("HARNESS_UNAVAILABLE", 409, "No CLI image for this harness");
    return harness;
  }

  private name(id: string): string {
    return `sandlane-run-${createHash("sha256").update(`${this.config.nodeId}:${id}`).digest("hex")}`;
  }

  private labels(record: RecordState): Record<string, string> {
    return {
      [this.owner]: this.config.nodeId,
      [`${this.owner}.allocation`]: record.resourceAllocationId ?? record.ref.allocationId,
      [`${this.owner}.digest`]: record.resourceDigest ?? record.digest
    };
  }

  /** Network/container ownership remains tied to the first allocation across Run handoffs. */
  private resource(record: RecordState): RecordState {
    return record.resourceAllocationId
      ? {
          ...record,
          ref: { ...record.ref, allocationId: record.resourceAllocationId },
          digest: record.resourceDigest!
        }
      : record;
  }

  /** Resolve names only here; all subsequent reads/mutations use the inspected immutable ID. */
  private async inspectOwned(
    record: RecordState,
    containerId?: string
  ): Promise<{ id: string; running: boolean } | undefined> {
    let info: Record<string, unknown>;
    try {
      info = object(
        await this.engine.request("GET", `/containers/${containerId ?? record.containerName}/json`)
      );
    } catch (error) {
      if (error instanceof BrokerError && error.status === 404) return;
      throw error;
    }
    const labels = object(object(info.Config).Labels);
    if (Object.entries(this.labels(record)).some(([k, v]) => labels[k] !== v)) {
      throw new BrokerError(
        "OWNERSHIP_MISMATCH",
        409,
        "Container ownership does not match allocation"
      );
    }
    // Exact inspected ID avoids deleting a different container recreated under the same name.
    const id = String(info.Id);
    if (!/^[a-f0-9]{64}$/.test(id) || (containerId !== undefined && containerId !== id)) {
      throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid container ID");
    }
    const running = object(info.State).Running;
    if (typeof running !== "boolean")
      throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid container state");
    return { id, running };
  }

  private async removeOwned(record: RecordState): Promise<void> {
    const container = await this.inspectOwned(record);
    if (container)
      await this.engine.request("DELETE", `/containers/${container.id}?force=true&v=true`);
    if (record.networkMode === "isolated") await this.networks.remove(this.resource(record));
    this.sessionLaunches.delete(record.ref.allocationId);
    this.inputDigests.delete(record.ref.allocationId);
  }

  async init(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.config.stateDir)) {
      if (!file.endsWith(".json")) continue;
      const raw = object(
        JSON.parse(await readFile(path.join(this.config.stateDir, file), "utf8")) as unknown
      );
      const ref = parseRef(raw.ref);
      if (
        file !== `${ref.allocationId}.json` ||
        raw.containerName !==
          this.name(
            raw.resourceAllocationId === undefined
              ? ref.allocationId
              : identifier(raw.resourceAllocationId)
          ) ||
        typeof raw.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.digest) ||
        !Number.isSafeInteger(raw.expiresAt) ||
        !["allocating", "running", "terminated", "failed"].includes(String(raw.state))
      ) {
        throw new Error("Invalid Broker ledger; manual reconciliation required");
      }
      const record: RecordState = {
        ref,
        digest: raw.digest,
        userId: identifier(raw.userId),
        containerName: String(raw.containerName),
        expiresAt: Number(raw.expiresAt),
        state: raw.state as State,
        ...(raw.harness !== undefined ? { harness: harnessId(raw.harness) } : {})
      };
      if (raw.sessionKey !== undefined) {
        if (
          typeof raw.sessionKey !== "string" ||
          !/^[a-f0-9]{64}$/.test(raw.sessionKey) ||
          typeof raw.resourceDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(raw.resourceDigest)
        ) {
          throw new Error("Invalid session resource ledger");
        }
        record.sessionKey = raw.sessionKey;
        record.resourceAllocationId = identifier(raw.resourceAllocationId);
        record.resourceDigest = raw.resourceDigest;
        if (raw.idleUntil !== undefined) {
          if (
            !Number.isSafeInteger(raw.idleUntil) ||
            Number(raw.idleUntil) < 1 ||
            record.state !== "terminated"
          )
            throw new Error("Invalid idle ledger");
          record.idleUntil = Number(raw.idleUntil);
        }
        if (raw.stopEvidence === "process-namespace-stopped")
          record.stopEvidence = raw.stopEvidence;
      } else if (
        raw.resourceAllocationId !== undefined ||
        raw.resourceDigest !== undefined ||
        raw.idleUntil !== undefined
      ) {
        throw new Error("Session resource has no owner");
      }
      if (raw.channelOpened !== undefined) {
        if (raw.channelOpened !== true) throw new Error("Invalid Broker channel ledger");
        record.channelOpened = true;
      }
      if (raw.networkMode !== undefined) {
        if (raw.networkMode !== "isolated") throw new Error("Invalid Broker network ledger");
        record.networkMode = "isolated";
      }
      if (raw.networkId !== undefined) {
        if (
          record.networkMode !== "isolated" ||
          typeof raw.networkId !== "string" ||
          !/^[a-f0-9]{64}$/.test(raw.networkId)
        )
          throw new Error("Invalid Broker network ID ledger");
        record.networkId = raw.networkId;
      }
      if (raw.relay !== undefined) {
        if (record.networkMode !== "isolated")
          throw new Error("Relay requires isolated network ledger");
        record.relay = parseRelayBinding(raw.relay);
      }
      if (raw.launchDigest !== undefined) {
        if (
          !record.relay ||
          typeof raw.launchDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(raw.launchDigest)
        )
          throw new Error("Invalid managed launch ledger");
        record.launchDigest = raw.launchDigest;
      }
      if (Object.hasOwn(raw, "leaseExpiresAt")) {
        if (
          !Number.isSafeInteger(raw.leaseExpiresAt) ||
          Number(raw.leaseExpiresAt) < 1 ||
          Number(raw.leaseExpiresAt) > record.expiresAt
        )
          throw new Error("Invalid Broker lease ledger");
        record.leaseExpiresAt = Number(raw.leaseExpiresAt);
      }
      this.records.set(ref.allocationId, record);
      // No durable control-plane lease yet: on restart, never resume old execution automatically.
      if (holdsCapacity(record) || record.idleUntil !== undefined) {
        await this.removeOwned(record);
        await this.save({
          ...record,
          state: "terminated",
          idleUntil: undefined,
          ...(record.sessionKey ? { stopEvidence: "process-namespace-stopped" as const } : {})
        });
      }
    }
    const filter = encodeURIComponent(
      JSON.stringify({ label: [`${this.owner}=${this.config.nodeId}`] })
    );
    const existing = await this.engine.request(
      "GET",
      `/containers/json?all=true&filters=${filter}`
    );
    if (!Array.isArray(existing) || existing.length !== 0) {
      throw new BrokerError(
        "ORPHANED_NODE",
        503,
        "Node has unaccounted containers; quarantine and reconcile before admission"
      );
    }
    await this.networks.assertNoOrphans();
    this.ready = true;
  }

  /** Allocation without per-Run gateway configuration; the CLI starts with its base arguments. */
  async allocate(value: unknown): Promise<RecordState> {
    return this.allocateRun(value);
  }

  async allocateManaged(value: unknown): Promise<RecordState> {
    const envelope = object(value);
    exactKeys(envelope, ["spec", "authorization"]);
    const spec = parseRunSpec(envelope.spec, this.clock());
    const authorization = parseRunAuthorization(
      envelope.authorization,
      spec.expiresAt,
      this.clock()
    );
    return this.allocateRun(spec, authorization);
  }

  private async allocateRun(
    value: unknown,
    authorization?: Readonly<RunAuthorization>
  ): Promise<RecordState> {
    const captured = parseRunSpec(value, this.clock());
    return this.serial(async () => {
      if (!this.ready || !this.healthy)
        throw new BrokerError("NOT_READY", 503, "Broker not ready for admission");
      // Freeze caller-owned inputs before queueing, then recheck deadlines when the queue drains.
      const spec = parseRunSpec(captured, this.clock());
      // Definite: this node has no image for the Harness, so no retry here can succeed.
      if (!Object.hasOwn(this.config.harnesses, spec.harness))
        throw new BrokerError("HARNESS_UNAVAILABLE", 409, "No CLI image for this harness");
      const harness = this.config.harnesses[spec.harness]!;
      const policy = this.config.managedGateways;
      if (!!authorization !== !!policy)
        throw new BrokerError("MANAGED_LAUNCH_REQUIRED", 409, "Launch must match node policy");
      const auth = authorization
        ? parseRunAuthorization(authorization, spec.expiresAt, this.clock())
        : undefined;
      const authorizedDigest = policy && auth ? launchDigest(policy, auth) : undefined;
      const digest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
      const old = this.records.get(spec.allocationId);
      if (old) {
        if (old.digest !== digest || old.launchDigest !== authorizedDigest)
          throw new BrokerError("ALLOCATION_CONFLICT", 409, "Allocation ID is already bound");
        return structuredClone(old); // Never recreate a completed/failed allocation on request replay.
      }
      const previous = [...this.records.values()].filter(
        r => r.ref.tenantId === spec.tenantId && r.ref.runId === spec.runId
      );
      if (previous.some(r => r.ref.generation >= spec.generation)) {
        throw new BrokerError(
          "STALE_GENERATION",
          409,
          "Run generation has already been used on this node"
        );
      }
      const active = [...this.records.values()].filter(holdsCapacity);
      const sessionKey = spec.session
        ? createHash("sha256")
            .update(
              // Different Harnesses run different images: never share a session container.
              JSON.stringify([
                spec.tenantId,
                spec.userId,
                spec.session.memberId,
                spec.session.taskId,
                spec.harness
              ])
            )
            .digest("hex")
        : undefined;
      if (
        sessionKey &&
        (!auth || !this.engine.startExec || active.some(r => r.sessionKey === sessionKey))
      ) {
        throw new BrokerError("SESSION_UNAVAILABLE", 409, "Session is busy or unsupported");
      }
      // File tools exist only with conversation files, which only a session can receive.
      if (auth?.fileTools && !sessionKey)
        throw new BrokerError("FILE_TOOLS_DENIED", 409, "File tools require a session");
      let idle: RecordState | undefined;
      for (const candidate of this.records.values()) {
        if (candidate.idleUntil === undefined) continue;
        if (candidate.idleUntil <= this.clock()) {
          await this.removeOwned(candidate);
          await this.save({ ...candidate, idleUntil: undefined });
        } else if (candidate.sessionKey === sessionKey) idle = candidate;
      }
      if (active.some(r => r.ref.runId === spec.runId && r.ref.tenantId === spec.tenantId)) {
        throw new BrokerError(
          "RUN_ACTIVE",
          409,
          "Run already has an active allocation on this node"
        );
      }
      if (
        active.length >= this.config.maxConcurrent ||
        active.filter(r => r.ref.tenantId === spec.tenantId).length >= this.config.perTenant
      ) {
        throw new BrokerError("CAPACITY", 429, "Node or tenant capacity exhausted");
      }
      const record: RecordState = {
        ref: {
          allocationId: spec.allocationId,
          runId: spec.runId,
          tenantId: spec.tenantId,
          generation: spec.generation
        },
        userId: spec.userId,
        digest,
        expiresAt: spec.expiresAt,
        leaseExpiresAt: spec.leaseExpiresAt,
        state: "allocating",
        harness: spec.harness,
        ...(this.config.networkMode === "isolated" ? { networkMode: "isolated" as const } : {}),
        ...(this.config.relay ? { relay: this.config.relay } : {}),
        ...(authorizedDigest ? { launchDigest: authorizedDigest } : {}),
        containerName: idle?.containerName ?? this.name(spec.allocationId),
        ...(sessionKey
          ? {
              sessionKey,
              resourceAllocationId: idle?.resourceAllocationId ?? spec.allocationId,
              resourceDigest: idle?.resourceDigest ?? digest,
              ...(idle?.networkId ? { networkId: idle.networkId } : {})
            }
          : {})
      };
      // Idle containers share the existing node/tenant capacity limit, and are evicted first.
      for (const candidate of [...this.records.values()].filter(
        r => r.idleUntil !== undefined && r !== idle
      )) {
        const retained = [...this.records.values()].filter(
          r => holdsCapacity(r) || r.idleUntil !== undefined
        );
        if (
          retained.length < this.config.maxConcurrent &&
          retained.filter(r => r.ref.tenantId === spec.tenantId).length < this.config.perTenant
        )
          break;
        await this.removeOwned(candidate);
        await this.save({ ...candidate, idleUntil: undefined });
      }
      // Intent durable before create; retry/restart can reconcile a lost Docker response by exact name.
      await this.save(record);
      try {
        if (idle) await this.save({ ...idle, idleUntil: undefined });
        if (record.networkMode === "isolated" && !idle) {
          record.networkId = await this.networks.create(record);
          await this.save(record);
          await this.networks.connectRelay(record);
        }
        const launch =
          policy && auth
            ? managedLaunch(
                policy,
                auth,
                await this.networks.relayAddress(
                  this.resource(record),
                  idle ? (await this.inspectOwned(record))?.id : undefined
                ),
                harness.launcher
              )
            : undefined;
        if (record.sessionKey && launch) this.sessionLaunches.set(spec.allocationId, launch);
        if (idle) {
          const container = await this.inspectOwned(record);
          if (!container?.running) throw new Error("Idle session disappeared");
          await this.networks.validate(this.resource(record), container.id);
          return structuredClone(record);
        }
        const created = object(
          await this.engine.request(
            "POST",
            `/containers/create?name=${record.containerName}`,
            this.containerSpec(record, launch)
          )
        );
        if (typeof created.Id !== "string" || !/^[a-f0-9]{64}$/.test(created.Id)) {
          throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid created container ID");
        }
        const container = await this.inspectOwned(record, created.Id);
        if (!container)
          throw new BrokerError("ENGINE_FAILURE", 502, "Created container disappeared");
        if (this.clock() >= executionDeadline(record))
          throw new BrokerError("LEASE_EXPIRED", 409, "Lease expired before start");
        // The CLI starts only after the authenticated Host has attached stdout/stdin (see
        // openChannel). Otherwise startup notifications can be lost before the Driver sees them.
        return structuredClone(record);
      } catch (error) {
        // If cleanup cannot be proved, keep allocating state and its capacity reservation.
        try {
          await this.removeOwned(record);
          await this.save({ ...record, state: "failed" });
        } catch (cleanupError) {
          this.healthy = false;
          throw cleanupError;
        }
        throw error;
      }
    });
  }

  private containerSpec(record: RecordState, launch?: ReturnType<typeof managedLaunch>): unknown {
    const { image, launcher: harness, memoryMiB } = this.harnessOf(record);
    const memory = (memoryMiB ?? DEFAULT_MEMORY_MIB) * MIB;
    // Fixed profile: the caller supplies Run data, never Docker flags or host mounts. Session
    // containers idle without credentials; each CLI then runs through an exec.
    return {
      Image: image,
      User: "1000:1000",
      WorkingDir: "/workspace",
      Entrypoint: record.sessionKey ? ["/bin/sleep"] : [harness.command],
      Cmd: record.sessionKey ? ["infinity"] : (launch?.args ?? [...harness.args]),
      Env: [
        ...(record.sessionKey ? [] : (launch?.env ?? [])),
        "HOME=/home/runner",
        ...Object.entries(harness.env).map(([key, value]) => `${key}=${value}`),
        "PATH=/usr/local/bin:/usr/bin:/bin"
      ],
      Labels: this.labels(record),
      NetworkDisabled: record.networkMode !== "isolated",
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      HostConfig: {
        NetworkMode: record.networkId ?? "none",
        ...(launch ? { ExtraHosts: launch.extraHosts } : {}),
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 128,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: 1_000_000_000,
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,nodev,size=32m,mode=1777",
          "/workspace": `rw,nosuid,nodev,size=${this.config.workspaceMiB}m,uid=1000,gid=1000,mode=0700`,
          "/home/runner": STATE_DIR_OPTIONS,
          ...Object.fromEntries(harness.stateDirs.map(dir => [dir, STATE_DIR_OPTIONS]))
        },
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
        LogConfig: { Type: "none" }
      }
    };
  }

  async inspect(value: unknown): Promise<RecordState> {
    const ref = parseRef(value);
    return this.serial(async () => structuredClone(this.bound(ref)));
  }

  /** Authenticated Host-only channel. One durable attachment per allocation; reconnect means stop/reconcile. */
  async openChannel(value: unknown, signal: AbortSignal): Promise<DockerAttachChannel> {
    const ref = parseRef(value);
    return this.serial(async () => {
      const record = this.bound(ref);
      if (
        !this.ready ||
        !this.healthy ||
        record.channelOpened ||
        record.state !== "allocating" ||
        (!record.sessionKey && !this.engine.attach) ||
        (record.sessionKey && !this.engine.startExec) ||
        executionDeadline(record) <= this.clock()
      )
        throw new BrokerError("CHANNEL_DENIED", 409, "Allocation has no available byte channel");
      signal.throwIfAborted();
      const container = await this.inspectOwned(record);
      if (!container || (!record.sessionKey && container.running))
        throw new BrokerError("CHANNEL_DENIED", 409, "Unexpected container state");
      // Persist the one-shot fence before any socket/CLI side effects.
      const attached = { ...record, channelOpened: true as const };
      await this.save(attached);
      let channel: DockerAttachChannel | undefined;
      try {
        if (record.networkMode === "isolated")
          await this.networks.validate(
            this.resource(record),
            container.running ? container.id : undefined
          );
        if (record.sessionKey) {
          const launch = this.sessionLaunches.get(ref.allocationId);
          if (!launch) throw new Error("Session credentials unavailable");
          // A CLI with file tools starts only over the files it was launched for.
          if (launch.fileTools && !this.inputDigests.has(ref.allocationId))
            throw new Error("Session inputs missing");
          if (!container.running)
            await this.engine.request("POST", `/containers/${container.id}/start`);
          const execId = await new SessionProcesses(this.engine).create(
            container.id,
            [this.harnessOf(record).launcher.command, ...launch.args],
            launch.env
          );
          this.sessionLaunches.delete(ref.allocationId);
          channel = await this.engine.startExec!(execId, record.expiresAt, signal);
        } else channel = await this.engine.attach!(container.id, record.expiresAt, signal);
        signal.throwIfAborted();
        if (executionDeadline(record) <= this.clock()) throw new Error("Expired channel");
        if (!record.sessionKey)
          await this.engine.request("POST", `/containers/${container.id}/start`);
        if (record.networkMode === "isolated")
          await this.networks.validate(this.resource(record), container.id);
        if (signal.aborted || executionDeadline(record) <= this.clock())
          throw new Error("Expired channel");
        await this.save({ ...attached, state: "running" });
        if (signal.aborted || executionDeadline(record) <= this.clock())
          throw new Error("Expired channel");
        return channel;
      } catch {
        channel?.close();
        try {
          await this.removeOwned(attached);
          await this.save({ ...attached, state: "failed" });
        } catch {
          this.healthy = false;
        }
        throw new BrokerError(
          "CHANNEL_UNAVAILABLE",
          503,
          "Byte channel failed; reconcile original allocation"
        );
      }
    });
  }

  /** Write the Run's input files into a session allocation's workspace before its CLI starts
   * (state allocating, no channel yet). The Broker builds the archive from validated names and
   * bytes and extracts it in the container as the runner user; an unstarted session container is
   * started first (its idle command has no credentials). Idempotent per allocation: the same
   * request again is acknowledged without writing, a different one is refused. A failure leaves
   * the allocation to be terminated by the caller (or the watchdog at lease expiry). */
  async putInputs(body: Buffer): Promise<{ ref: AllocationRef; files: number; bytes: number }> {
    const request = decodeInputs(body);
    const digest = createHash("sha256").update(body).digest("hex");
    const receipt = () => ({
      ref: { ...request.ref },
      files: request.files.length,
      bytes: request.files.reduce((sum, file) => sum + file.data.length, 0)
    });
    return this.serial(async () => {
      if (!this.ready || !this.healthy) throw new BrokerError("NOT_READY", 503, "Broker not ready");
      const record = this.bound(request.ref);
      const written = this.inputDigests.get(record.ref.allocationId);
      if (written === digest) return receipt();
      if (written !== undefined)
        throw new BrokerError("INPUTS_CONFLICT", 409, "Allocation already has other inputs");
      if (
        !record.sessionKey ||
        !this.engine.startExec ||
        record.state !== "allocating" ||
        record.channelOpened ||
        executionDeadline(record) <= this.clock()
      )
        throw new BrokerError("INPUTS_DENIED", 409, "Allocation cannot receive inputs");
      const container = await this.inspectOwned(record);
      if (!container) throw new BrokerError("INPUTS_DENIED", 409, "Unexpected container state");
      if (!container.running) {
        if (record.networkMode === "isolated")
          await this.networks.validate(this.resource(record), undefined);
        await this.engine.request("POST", `/containers/${container.id}/start`);
      }
      if (record.networkMode === "isolated")
        await this.networks.validate(this.resource(record), container.id);
      const deadline = Math.min(executionDeadline(record), this.clock() + INPUTS_TIMEOUT_MS);
      await new SessionProcesses(this.engine).extract(
        container.id,
        inputArchive(request.files, this.clock()),
        deadline,
        AbortSignal.timeout(Math.max(1, deadline - this.clock()))
      );
      this.inputDigests.set(record.ref.allocationId, digest);
      return receipt();
    });
  }

  /** Read the generated files out of a running file-mode session (its CLI has ended its turn; the
   * allocation is not yet terminated): the regular files directly in `<workspace>/outputs`
   * within the output limits, plus the entries refused and why (see session-outputs). No outputs
   * directory means an empty reply. Read-only: nothing in the container changes.
   *
   * Only the checks run in the operation queue. The reads themselves (up to tens of MiB, several
   * seconds) run outside it, so they never delay renewals or allocations of other Runs; a
   * concurrent terminate simply fails the read. */
  async getOutputs(value: unknown): Promise<Buffer[]> {
    const ref = parseRef(value);
    const target = await this.serial(async () => {
      if (!this.ready || !this.healthy) throw new BrokerError("NOT_READY", 503, "Broker not ready");
      const record = this.bound(ref);
      // Inputs are written for every file-mode allocation, and only for those.
      if (
        !record.sessionKey ||
        !this.engine.startExec ||
        record.state !== "running" ||
        !this.inputDigests.has(record.ref.allocationId) ||
        executionDeadline(record) <= this.clock()
      )
        throw new BrokerError("OUTPUTS_DENIED", 409, "Allocation cannot return outputs");
      const container = await this.inspectOwned(record);
      if (!container?.running)
        throw new BrokerError("OUTPUTS_DENIED", 409, "Unexpected container state");
      return {
        id: container.id,
        deadline: Math.min(executionDeadline(record), this.clock() + OUTPUTS_TIMEOUT_MS)
      };
    });
    const signal = AbortSignal.timeout(Math.max(1, target.deadline - this.clock()));
    return encodeOutputs(await this.readOutputs(target.id, target.deadline, signal));
  }

  private async readOutputs(
    containerId: string,
    deadline: number,
    signal: AbortSignal
  ): Promise<CollectedOutputs> {
    const limits = this.config.outputLimits ?? DEFAULT_OUTPUT_LIMITS;
    const processes = new SessionProcesses(this.engine);
    const listed = await processes.read(
      containerId,
      LIST_COMMAND,
      LISTING_MAX_BYTES,
      deadline,
      signal
    );
    // find exits 1 when it could not read some directory; what it printed is still exact.
    if (listed.complete && listed.exitCode !== 0 && listed.exitCode !== 1)
      throw new BrokerError("OUTPUTS_FAILED", 503, "Output listing failed");
    const plan = planOutputs(parseListing(listed.stdout), limits);
    if (!plan.selected.length) return { files: [], rejected: plan.rejected };
    const archived = await processes.read(
      containerId,
      archiveCommand(plan.selected.map(file => file.name)),
      archiveLimit(plan),
      deadline,
      signal
    );
    // tar exits 1 when a file changed while it was read: its bytes cannot be trusted either.
    if (!archived.complete || archived.exitCode !== 0)
      throw new BrokerError("OUTPUTS_FAILED", 503, "Output archive failed");
    return collectOutputs(plan, parseArchive(archived.stdout), limits);
  }

  /** Trusted Host must first persist and obtain the exact Engine CAS acknowledgement.
   * This local fence never grants business authority or revives a stopped/expired container. */
  async renew(value: unknown): Promise<RecordState> {
    // Capture before waiting behind other Docker operations; caller mutations cannot retarget IO.
    const request = parseRenewal(value);
    return this.serial(async () => {
      if (!this.ready || !this.healthy) throw new BrokerError("NOT_READY", 503, "Broker not ready");
      const record = this.bound(request.ref);
      const now = this.clock();
      if (
        record.state !== "running" ||
        record.leaseExpiresAt === undefined ||
        executionDeadline(record) <= now
      ) {
        throw new BrokerError("STALE_LEASE", 409, "Allocation is not renewable");
      }
      if (
        request.requestedExpiresAt > record.expiresAt ||
        request.requestedExpiresAt > now + 60000
      ) {
        throw new BrokerError("INVALID_SPEC", 400, "Renewal exceeds execution limit");
      }
      if (
        record.leaseExpiresAt !== request.expectedExpiresAt &&
        record.leaseExpiresAt !== request.requestedExpiresAt
      ) {
        throw new BrokerError("RENEWAL_CONFLICT", 409, "Another lease target is already recorded");
      }
      let container: { id: string; running: boolean } | undefined;
      try {
        container = await this.inspectOwned(record);
      } catch (error) {
        // Do not admit new workloads after an ownership mismatch or unknown daemon state.
        this.healthy = false;
        throw error;
      }
      if (!container?.running || executionDeadline(record) <= this.clock()) {
        throw new BrokerError(
          "STALE_LEASE",
          409,
          "Container stopped or lease expired during verification"
        );
      }
      if (record.leaseExpiresAt === request.requestedExpiresAt) return structuredClone(record);
      const renewed = { ...record, leaseExpiresAt: request.requestedExpiresAt };
      try {
        await this.save(renewed);
      } catch (error) {
        this.healthy = false;
        throw error;
      }
      return structuredClone(renewed);
    });
  }

  private bound(value: unknown): RecordState {
    const ref = parseRef(value);
    const record = this.records.get(ref.allocationId);
    if (
      !record ||
      record.ref.tenantId !== ref.tenantId ||
      record.ref.runId !== ref.runId ||
      record.ref.generation !== ref.generation
    ) {
      throw new BrokerError("NOT_FOUND", 404, "Allocation not found for this binding");
    }
    return record;
  }

  async terminate(value: unknown): Promise<RecordState> {
    const ref = parseRef(value);
    return this.serial(async () => {
      this.inputDigests.delete(ref.allocationId);
      // Cancellation may overtake start on separate HTTP connections. Persist a tombstone
      // before acknowledging absence, so a delayed allocate cannot create this workload.
      const record = this.records.has(ref.allocationId)
        ? this.bound(ref)
        : {
            ref,
            userId: "cancelled-before-start",
            digest: "0".repeat(64),
            expiresAt: 0,
            state: "allocating" as const,
            containerName: this.name(ref.allocationId)
          };
      // A late retry for an old Run must never stop a session already handed to a new Run.
      if (record.sessionKey && record.state === "terminated") return structuredClone(record);
      try {
        if (record.sessionKey && record.state === "running") {
          const container = await this.inspectOwned(record);
          if (container) {
            await new SessionProcesses(this.engine).stop(container.id);
            // Save execution stop before restarting only the credential-free idle process.
            const result: RecordState = {
              ...record,
              state: "terminated",
              stopEvidence: "process-namespace-stopped",
              idleUntil: this.clock() + 300_000
            };
            await this.save(result);
            try {
              await this.engine.request("POST", `/containers/${container.id}/start`);
              await this.networks.validate(this.resource(result), container.id);
              return structuredClone(result);
            } catch {
              await this.removeOwned(result);
              await this.save({ ...result, idleUntil: undefined });
              return structuredClone({ ...result, idleUntil: undefined });
            }
          }
        }
        await this.removeOwned(record);
        const result: RecordState = {
          ...record,
          state: "terminated",
          ...(record.sessionKey ? { stopEvidence: "process-namespace-stopped" as const } : {})
        };
        await this.save(result);
        return structuredClone(result);
      } catch (error) {
        this.healthy = false;
        throw error;
      }
    });
  }

  reconcile(): Promise<void> {
    return this.serial(async () => {
      try {
        for (const record of this.records.values()) await this.reconcileRecord(record);
        this.healthy = !this.persistenceFailed;
      } catch (error) {
        this.healthy = false;
        throw error;
      }
    });
  }

  private async reconcileRecord(record: RecordState): Promise<void> {
    if (record.idleUntil !== undefined) {
      if (record.idleUntil <= this.clock()) {
        await this.removeOwned(record);
        await this.save({ ...record, idleUntil: undefined });
      }
      return;
    }
    if (!holdsCapacity(record)) return;
    const container = await this.inspectOwned(record);
    if (
      record.networkMode === "isolated" &&
      container &&
      executionDeadline(record) > this.clock()
    ) {
      try {
        await this.networks.validate(
          this.resource(record),
          container.running ? container.id : undefined
        );
      } catch {
        // A dead/replaced Relay or a changed network must not leave a live CLI waiting
        // until the hard deadline. Cleanup still uses the persisted original identity.
        await this.removeOwned(record);
        await this.save({ ...record, state: "failed" });
        return;
      }
    }
    if (
      !record.channelOpened &&
      executionDeadline(record) > this.clock() &&
      container &&
      !container.running
    )
      return;
    if (executionDeadline(record) > this.clock() && container?.running) return;

    // Disk failure must never prevent killing an expired workload.
    await this.removeOwned(record);
    await this.save({
      ...record,
      state: "terminated",
      ...(record.sessionKey ? { stopEvidence: "process-namespace-stopped" as const } : {})
    });
  }

  shutdown(): Promise<void> {
    this.ready = false;
    return this.serial(async () => {
      for (const record of this.records.values()) {
        if (!holdsCapacity(record) && record.idleUntil === undefined) continue;
        await this.removeOwned(record);
        await this.save({
          ...record,
          state: "terminated",
          idleUntil: undefined,
          ...(record.sessionKey ? { stopEvidence: "process-namespace-stopped" as const } : {})
        });
      }
    });
  }
}
