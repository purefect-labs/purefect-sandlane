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
import path from "node:path";
import {
  managedTurnInput,
  parsePromptFormat,
  promptByteLimit
} from "../../common/turn-envelope.js";
import { webSearchActivity } from "../../common/web-activity.js";
import type {
  HarnessCapabilities,
  HarnessDriver,
  HarnessTransport,
  ProcessStopEvidence,
  RunInput,
  RuntimeEvent
} from "../../spi/harness.js";
import { codexManagedConfig, type CodexManagedConfig } from "./codex-managed-config.js";
import { LocalProcessTransport } from "./local-process-transport.js";

/** Codex app-server speaks Responses to the model gateway; one ephemeral thread per Run. */
export const CODEX_CAPABILITIES: HarnessCapabilities = Object.freeze({
  schemaVersion: 1,
  streamingText: true,
  interactiveInput: false,
  approvalBridge: false,
  nativeResume: false,
  modelWire: "responses",
  sessionPolicy: "ephemeral"
});
const INSTRUCTIONS_LIMIT = 16_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
type AdapterOptions = {
  workspace: string;
  onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
  reasoningEffort?: "low" | "medium" | "high";
} & (
  | { transport: HarnessTransport }
  | { home: string; command?: string; args?: string[]; managed?: CodexManagedConfig }
);

/** One instance, one execution. No shared Home, thread registry or environment inheritance. */
export class CodexRunAdapter extends EventEmitter implements HarnessDriver {
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly transport: HarnessTransport;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private sequence = 0;
  private input: RunInput | undefined;
  private buffer = Buffer.alloc(0);
  private terminal = false;
  private cancelled = false;
  private finished: (() => void) | undefined;
  private outputBytes = 0;
  private disposal: Promise<void> | undefined;
  private stopped: ProcessStopEvidence | undefined;
  private outgoing: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private readonly workspace: string;
  private readonly onTiming: AdapterOptions["onTiming"];
  private readonly reasoningEffort: AdapterOptions["reasoningEffort"];
  private startedAt = 0;
  private firstText = false;
  constructor(options: AdapterOptions) {
    super();
    this.workspace = options.workspace;
    this.onTiming = options.onTiming;
    if (
      options.reasoningEffort !== undefined &&
      !["low", "medium", "high"].includes(options.reasoningEffort)
    )
      throw new Error("Invalid reasoning effort");
    this.reasoningEffort = options.reasoningEffort;
    if ("transport" in options) this.transport = options.transport;
    else {
      const managed = options.managed ? codexManagedConfig(options.managed) : undefined;
      this.transport = new LocalProcessTransport({
        command: options.command ?? "codex",
        args: [...(options.args ?? ["app-server"]), ...(managed?.args ?? [])],
        workspace: options.workspace,
        home: options.home,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: options.home,
          CODEX_HOME: path.join(options.home, ".codex"),
          LANG: "C.UTF-8",
          ...managed?.env
        }
      });
    }
  }

  get stopEvidence(): ProcessStopEvidence | undefined {
    return this.stopped;
  }

  async execute(input: RunInput): Promise<void> {
    if (this.input) throw new Error("Adapter instances cannot be reused");
    if (this.disposal) throw new Error("Adapter is disposed");
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
      (input.fileTools !== undefined && typeof input.fileTools !== "boolean")
    )
      throw new Error("Invalid Run input or deadline");
    managedTurnInput(input.prompt, parsePromptFormat(input.promptFormat));
    if (
      input.contextData &&
      (!Array.isArray(input.contextData) ||
        input.contextData.length > 3 ||
        input.contextData.some(value => typeof value !== "string") ||
        Buffer.byteLength(JSON.stringify(input.contextData)) > 16000)
    )
      throw new Error("MEMORY_CONTEXT_LIMIT");
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
      () => {
        void this.cancel().catch(() => {});
      },
      Math.min(input.expiresAt - Date.now(), 30 * 60_000)
    );
    try {
      await this.transport.start({
        stdout: chunk => this.consume(chunk),
        fault: () => this.fail(new Error("Harness transport failed")),
        exited: () => {
          if (!this.terminal) this.fail(new Error("Harness exited before completion"));
        }
      });
      if (this.cancelled || this.terminal) return;
      this.timing("transport-ready");
      await this.request("initialize", {
        clientInfo: { name: "sandlane-run-adapter", version: "0.1.0" },
        capabilities: {}
      });
      await this.write({ method: "initialized" });
      this.timing("cli-initialized");
      const result = (await this.request("thread/start", {
        cwd: this.workspace,
        ephemeral: true,
        // File mode runs commands in the container itself (no network, read-only root, resource
        // limits); a Codex sandbox inside it cannot be set up and would block the work. Without
        // files the shell tool is off and the read-only sandbox stays as a second fence.
        sandbox: this.input.fileTools === true ? "danger-full-access" : "read-only",
        approvalPolicy: "never",
        ...(this.input.instructions ? { baseInstructions: this.input.instructions } : {})
      })) as { thread?: { id?: string } };
      if (!result.thread?.id) throw new Error("Missing thread ID");
      this.timing("thread-ready");
      if (this.input.beforeTurn) {
        // Cancellation or failure while waiting settles `done`; never start a turn afterwards.
        await Promise.race([this.input.beforeTurn(), done]);
        if (this.cancelled || this.terminal) return;
        this.timing("turn-admitted");
      }
      await this.request("turn/start", {
        threadId: result.thread.id,
        ...((this.input.reasoningEffort ?? this.reasoningEffort)
          ? { effort: this.input.reasoningEffort ?? this.reasoningEffort }
          : {}),
        input: [
          ...(this.input.contextData ?? []).map(text => ({
            type: "text",
            text,
            text_elements: []
          })),
          ...managedTurnInput(this.input.prompt, this.input.promptFormat)
        ]
      });
      await done;
      this.timing("turn-ended");
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Harness failure"));
    } finally {
      clearTimeout(deadline);
      await this.dispose();
      this.timing("process-stopped");
    }
  }

  private emitEvent(type: RuntimeEvent["type"], data: Record<string, unknown>): void {
    if (!this.input) return;
    if (type === "message.delta" && !this.firstText) {
      this.firstText = true;
      this.timing("first-text");
    }
    this.emit("event", {
      schemaVersion: 1,
      runId: this.input.runId,
      sequence: ++this.sequence,
      type,
      data
    } satisfies RuntimeEvent);
  }
  private timing(phase: string): void {
    if (!this.input) return;
    // Telemetry must not affect execution or contain prompts, model output or credentials.
    try {
      this.onTiming?.(this.input.runId, phase, Math.round(performance.now() - this.startedAt));
    } catch {}
  }
  private end(
    type: "run.completed" | "run.failed" | "run.cancelled",
    data: Record<string, unknown> = {}
  ): void {
    if (this.terminal) return;
    this.terminal = true;
    this.emitEvent(type, data);
    this.finished?.();
  }
  private fail(error: Error): void {
    this.end("run.failed", { code: "HARNESS_FAILURE" });
    this.rejectPending(error);
    void this.dispose().catch(() => {});
  }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  private write(value: unknown): Promise<void> {
    // Serialize protocol writes and charge queued bytes before enqueueing. A slow stdin
    // must not turn concurrent requests into an unbounded promise/buffer queue.
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    if (this.terminal || this.queuedBytes + frame.length > 128 * 1024)
      return Promise.reject(new Error("Harness input limit or closed"));
    this.queuedBytes += frame.length;
    const next = this.outgoing
      .then(() => {
        if (this.terminal) throw new Error("Harness closed");
        return this.transport.write(frame);
      })
      .finally(() => {
        this.queuedBytes -= frame.length;
      });
    this.outgoing = next.catch(() => {});
    return next;
  }
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.terminal) return Promise.reject(new Error("Run already terminal"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Harness request timed out"));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  private consume(chunk: Buffer): void {
    // Reassemble complete JSONL frames before decoding UTF-8; socket boundaries can split characters.
    if (this.terminal) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > 4 * 1024 * 1024) {
      this.fail(new Error("Run output limit"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      if (index > 128 * 1024) {
        this.fail(new Error("Frame limit"));
        return;
      }
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      try {
        this.message(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.fail(new Error("Invalid Harness frame"));
        return;
      }
    }
    if (this.buffer.length > 128 * 1024) this.fail(new Error("Frame limit"));
  }
  private message(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error) p.reject(new Error("Harness request rejected"));
      else p.resolve(message.result);
      return;
    }
    if (this.terminal) return;
    if ("id" in message && message.method) {
      // No interactive escalation, dynamic tools or approvals: every tool is an MCP tool of the
      // tool gateway, which Codex calls itself.
      void this.write({
        id: message.id,
        error: { code: -32601, message: "Tool/approval bridge is not enabled" }
      }).catch(() => this.fail(new Error("Harness response failed")));
      return;
    }
    const params = message.params as { delta?: unknown; turn?: { status?: string } } | undefined;
    if (message.method === "item/agentMessage/delta" && typeof params?.delta === "string")
      this.emitEvent("message.delta", { delta: params.delta });
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = activitySummary(
        (message.params as { item?: unknown } | undefined)?.item,
        message.method === "item/completed"
      );
      if (item)
        this.emitEvent(message.method === "item/started" ? "item.started" : "item.completed", {
          item
        });
    }
    if (message.method === "turn/completed")
      this.end(params?.turn?.status === "completed" ? "run.completed" : "run.failed");
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.end("run.cancelled");
    this.rejectPending(new Error("Run cancelled"));
    await this.dispose();
  }
  dispose(): Promise<void> {
    // Failure, deadline and explicit cancellation can race. All callers await the same stop.
    if (!this.disposal) {
      if (this.input && !this.terminal) {
        this.cancelled = true;
        this.end("run.cancelled");
      }
      this.rejectPending(new Error("Run disposed"));
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
}

const SUMMARY_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** Activity panel items: MCP tool calls and provider web searches. */
function activitySummary(raw: unknown, completed: boolean): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).type === "webSearch") {
    // app-server `webSearch`: the query arrives with completion; `action` is search (query),
    // openPage (url) or findInPage (url). Results are never forwarded.
    const item = raw as Record<string, unknown>;
    const action =
      item.action && typeof item.action === "object"
        ? (item.action as Record<string, unknown>)
        : {};
    return webSearchActivity(item.id, completed ? "completed" : "inProgress", {
      query: item.query || action.query,
      url: action.url
    });
  }
  return toolCallSummary(raw);
}

/** Tool-call activity for the user's activity panel: type, server, tool, status and the
 * `api_code` (or `code`) argument only. Arguments and results may hold business data and never leave here. */
function toolCallSummary(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (item.type !== "mcpToolCall") return undefined;
  const pick = (value: unknown) =>
    typeof value === "string" && SUMMARY_TEXT.test(value) ? value : undefined;
  const id = pick(item.id);
  const server = pick(item.server);
  const tool = pick(item.tool);
  if (!id || !server || !tool) return undefined;
  const args = item.arguments as Record<string, unknown> | undefined;
  const apiCode = args && typeof args === "object" ? pick(args.api_code ?? args.code) : undefined;
  const status = pick(item.status);
  return {
    type: "mcpToolCall",
    id,
    server,
    tool,
    ...(status ? { status } : {}),
    ...(apiCode ? { arguments: { api_code: apiCode } } : {})
  };
}
