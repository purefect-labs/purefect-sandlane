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
import { EventEmitter } from "node:events";
import {
  managedTurnInput,
  parsePromptFormat,
  promptByteLimit
} from "../../common/turn-envelope.js";
import type { ReasoningEffort } from "../../spi/control-plane.js";
import type {
  HarnessCapabilities,
  HarnessDriver,
  HarnessTransport,
  ProcessStopEvidence,
  RunInput,
  RuntimeEvent
} from "../../spi/harness.js";

const INSTRUCTIONS_LIMIT = 16_000;
const SHIM_PHASES = ["configuration", "start-frame", "invocation", "spawn", "child"] as const;
const CONTEXT_LIMIT = 16_000;
const FRAME_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

export interface SingleShotStart {
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly instructions?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface SingleShotProtocol {
  readonly capabilities: HarnessCapabilities;
  /** Consume one native CLI JSONL value. Returns a terminal result only for an authoritative
   * protocol terminal; the launch shim's process-exit frame is handled by the Driver. */
  consume(value: Record<string, unknown>, emit: SingleShotEmitter): SingleShotTerminal | undefined;
  /** OpenCode 1.x exits cleanly after session idle without a terminal JSON event; Qwen Code must
   * emit its own result. The protocol decides how a shim-reported child exit is classified. */
  exited(code: number): SingleShotTerminal;
}

export interface SingleShotEmitter {
  event(
    type: "message.delta" | "item.started" | "item.completed",
    data: Record<string, unknown>
  ): void;
}

export type SingleShotTerminal = Readonly<{
  type: "run.completed" | "run.failed" | "run.cancelled";
  data?: Record<string, unknown>;
}>;

export interface SingleShotDriverOptions {
  readonly transport: HarnessTransport;
  readonly protocol: () => SingleShotProtocol;
  readonly reasoningEffort?: ReasoningEffort;
  readonly onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
}

/** One process and one turn. A trusted image shim receives one bounded start frame only after
 * admission, starts the native CLI, closes its stdin and appends a sanitized process-exit frame. */
export class SingleShotDriver extends EventEmitter implements HarnessDriver {
  readonly capabilities: HarnessCapabilities;
  private readonly transport: HarnessTransport;
  private readonly protocol: SingleShotProtocol;
  private readonly reasoningEffort: ReasoningEffort | undefined;
  private readonly onTiming: SingleShotDriverOptions["onTiming"];
  private input: RunInput | undefined;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private outputBytes = 0;
  private terminal = false;
  private cancelled = false;
  private firstText = false;
  private startedAt = 0;
  private finished: (() => void) | undefined;
  private disposal: Promise<void> | undefined;
  private stopped: ProcessStopEvidence | undefined;

  constructor(options: SingleShotDriverOptions) {
    super();
    if (options.reasoningEffort !== undefined && !EFFORTS.includes(options.reasoningEffort))
      throw new Error("Invalid reasoning effort");
    this.transport = options.transport;
    this.protocol = options.protocol();
    this.capabilities = this.protocol.capabilities;
    this.reasoningEffort = options.reasoningEffort;
    this.onTiming = options.onTiming;
  }

  get stopEvidence(): ProcessStopEvidence | undefined {
    return this.stopped;
  }

  async execute(input: RunInput): Promise<void> {
    if (this.input) throw new Error("Driver instances cannot be reused");
    if (this.disposal) throw new Error("Driver is disposed");
    const effort = input.reasoningEffort ?? this.reasoningEffort;
    if (
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Date.now() ||
      input.expiresAt > Date.now() + 30 * 60_000 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.runId) ||
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      Buffer.byteLength(input.prompt) > promptByteLimit(input.promptFormat) ||
      (input.instructions !== undefined &&
        (typeof input.instructions !== "string" ||
          Buffer.byteLength(input.instructions) > INSTRUCTIONS_LIMIT)) ||
      (effort !== undefined && !EFFORTS.includes(effort)) ||
      input.fileTools === true
    )
      throw new Error("Invalid or unsupported Run input");
    const turn = managedTurnInput(input.prompt, parsePromptFormat(input.promptFormat));
    if (
      input.contextData &&
      (!Array.isArray(input.contextData) ||
        input.contextData.length > 3 ||
        input.contextData.some(value => typeof value !== "string") ||
        Buffer.byteLength(JSON.stringify(input.contextData)) > CONTEXT_LIMIT)
    )
      throw new Error("MEMORY_CONTEXT_LIMIT");
    const prompt = [...(input.contextData ?? []), ...turn.map(item => item.text)].join("\n\n");
    this.input = Object.freeze({ ...input });
    const now = performance.now();
    const origin = input.timingOrigin;
    this.startedAt =
      typeof origin === "number" && Number.isFinite(origin) && origin <= now ? origin : now;
    this.timing("driver-start");
    const done = new Promise<void>(resolve => {
      this.finished = resolve;
    });
    const deadline = setTimeout(
      () => void this.cancel().catch(() => {}),
      Math.min(input.expiresAt - Date.now(), 30 * 60_000)
    );
    try {
      await this.transport.start({
        stdout: chunk => this.consume(chunk),
        fault: () => this.fail("HARNESS_TRANSPORT"),
        exited: () => {
          if (!this.terminal) this.fail("HARNESS_EXITED");
        }
      });
      if (this.cancelled || this.terminal) return;
      this.timing("transport-ready");
      if (input.beforeTurn) {
        await Promise.race([input.beforeTurn(), done]);
        if (this.cancelled || this.terminal) return;
        this.timing("turn-admitted");
      }
      const start: SingleShotStart = Object.freeze({
        schemaVersion: 1,
        prompt,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(effort ? { reasoningEffort: effort } : {})
      });
      const frame = Buffer.from(`${JSON.stringify(start)}\n`);
      if (frame.length > 128 * 1024) throw new Error("Harness start frame limit");
      await this.transport.write(frame);
      this.timing("cli-started");
      await done;
      this.timing("turn-ended");
    } catch {
      this.fail("HARNESS_FAILURE");
    } finally {
      clearTimeout(deadline);
      await this.dispose();
      this.timing("process-stopped");
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.end("run.cancelled");
    await this.dispose();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      if (this.input && !this.terminal) this.end(this.cancelled ? "run.cancelled" : "run.failed");
      this.disposal = this.stopTransport();
    }
    return this.disposal;
  }

  private async stopTransport(): Promise<void> {
    try {
      this.stopped = Object.freeze(await this.transport.stop());
    } catch {
      this.stopped = Object.freeze({ state: "unknown" });
    }
    this.buffer = Buffer.alloc(0);
    if (this.stopped.state === "unknown") throw new Error("Harness stop unconfirmed");
  }

  private consume(chunk: Buffer): void {
    if (this.terminal) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > OUTPUT_LIMIT) return this.fail("HARNESS_OUTPUT_LIMIT");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      if (index > FRAME_LIMIT) return this.fail("HARNESS_FRAME_LIMIT");
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return this.fail("HARNESS_PROTOCOL");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        return this.fail("HARNESS_PROTOCOL");
      const record = value as Record<string, unknown>;
      const shim = record._sandlane;
      if (shim && typeof shim === "object" && !Array.isArray(shim)) {
        const exit = shim as Record<string, unknown>;
        if (
          Object.keys(record).length !== 1 ||
          exit.schemaVersion !== 1 ||
          exit.event !== "exit" ||
          !Number.isSafeInteger(exit.code) ||
          Number(exit.code) < 0 ||
          Number(exit.code) > 255 ||
          (exit.phase !== undefined &&
            !SHIM_PHASES.includes(exit.phase as (typeof SHIM_PHASES)[number]))
        )
          return this.fail("HARNESS_PROTOCOL");
        if (this.terminal) return;
        if (typeof exit.phase === "string") this.timing(`shim-${exit.phase}`);
        const terminal = this.protocol.exited(Number(exit.code));
        this.end(terminal.type, terminal.data);
        continue;
      }
      try {
        const terminal = this.protocol.consume(record, {
          event: (type, data) => this.emitEvent(type, data)
        });
        if (terminal) this.end(terminal.type, terminal.data);
      } catch {
        return this.fail("HARNESS_PROTOCOL");
      }
    }
    if (this.buffer.length > FRAME_LIMIT) this.fail("HARNESS_FRAME_LIMIT");
  }

  private emitEvent(type: RuntimeEvent["type"], data: Record<string, unknown>): void {
    if (!this.input || this.terminal) return;
    if (type === "message.delta") {
      const delta = data.delta;
      if (typeof delta !== "string" || !delta) return;
      if (!this.firstText) {
        this.firstText = true;
        this.timing("first-text");
      }
    }
    this.emit("event", {
      schemaVersion: 1,
      runId: this.input.runId,
      sequence: ++this.sequence,
      type,
      data
    } satisfies RuntimeEvent);
  }

  private end(type: SingleShotTerminal["type"], data: Record<string, unknown> = {}): void {
    if (this.terminal) return;
    this.terminal = true;
    if (!this.input) return;
    this.emit("event", {
      schemaVersion: 1,
      runId: this.input.runId,
      sequence: ++this.sequence,
      type,
      data
    } satisfies RuntimeEvent);
    this.finished?.();
  }

  private fail(code: string): void {
    this.timing(`failed-${code.toLowerCase()}`);
    this.end("run.failed", { code });
    void this.dispose().catch(() => {});
  }

  private timing(phase: string): void {
    if (!this.input) return;
    try {
      this.onTiming?.(this.input.runId, phase, Math.round(performance.now() - this.startedAt));
    } catch {}
  }
}
