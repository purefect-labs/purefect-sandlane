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
/** Claude Code Driver: one `claude -p` stream-json process per Run (see claude-code-launcher).
 * Control requests on stdin set the system prompt and effort before the turn; the CLI's
 * stream_event / assistant / user / result lines become standard RuntimeEvents. */
import { EventEmitter } from "node:events";
import {
  managedTurnInput,
  parsePromptFormat,
  promptByteLimit
} from "../../common/turn-envelope.js";
import { webSearchActivity } from "../../common/web-activity.js";
import type { ReasoningEffort } from "../../spi/control-plane.js";
import type {
  HarnessCapabilities,
  HarnessDriver,
  HarnessTransport,
  ProcessStopEvidence,
  RunInput,
  RuntimeEvent
} from "../../spi/harness.js";
import { CLAUDE_CODE_WEB_FUNCTIONS } from "./claude-code-launcher.js";

/** Speaks Anthropic Messages to the model gateway; tools (the client action included) come from
 * the tool gateway over MCP. */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  schemaVersion: 1,
  streamingText: true,
  interactiveInput: false,
  approvalBridge: false,
  nativeResume: false,
  modelWire: "anthropic-messages",
  sessionPolicy: "ephemeral"
});

const INSTRUCTIONS_LIMIT = 16_000;
/** stdout lines carry whole tool results and the initialize reply (skill catalog). */
const FRAME_LIMIT = 1024 * 1024;
/** Partial messages repeat session and message IDs per token: far more bytes than Codex. */
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 10_000;
const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ClaudeCodeDriverOptions {
  transport: HarnessTransport;
  onTiming?: (runId: string, phase: string, elapsedMs: number) => void;
  /** Default effort when the Run carries none; absent = the CLI's default. */
  reasoningEffort?: ReasoningEffort;
  /** How long a cancelled turn may take to report its interrupted result. */
  interruptGraceMs?: number;
}

type Line = Record<string, unknown>;

/** One instance, one execution. */
export class ClaudeCodeDriver extends EventEmitter implements HarnessDriver {
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  private readonly transport: HarnessTransport;
  private readonly onTiming: ClaudeCodeDriverOptions["onTiming"];
  private readonly reasoningEffort: ReasoningEffort | undefined;
  private readonly interruptGraceMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly tools = new Map<string, Record<string, unknown>>();
  private input: RunInput | undefined;
  private nextId = 0;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private outputBytes = 0;
  private outgoing: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private terminal = false;
  private cancelled = false;
  private turnStarted = false;
  private firstText = false;
  private startedAt = 0;
  private finished: (() => void) | undefined;
  private disposal: Promise<void> | undefined;
  private stopped: ProcessStopEvidence | undefined;

  constructor(options: ClaudeCodeDriverOptions) {
    super();
    if (options.reasoningEffort !== undefined && !EFFORTS.includes(options.reasoningEffort))
      throw new Error("Invalid reasoning effort");
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.interruptGraceMs) ||
      this.interruptGraceMs < 0 ||
      this.interruptGraceMs > 30_000
    )
      throw new Error("Invalid interrupt grace");
    this.transport = options.transport;
    this.onTiming = options.onTiming;
    this.reasoningEffort = options.reasoningEffort;
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
      (effort !== undefined && !EFFORTS.includes(effort))
    )
      throw new Error("Invalid Run input or deadline");
    const turn = managedTurnInput(input.prompt, parsePromptFormat(input.promptFormat));
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
      // A custom system prompt replaces the CLI's built-in one (like Codex baseInstructions).
      await this.control({
        subtype: "initialize",
        ...(this.input.instructions ? { systemPrompt: [this.input.instructions] } : {})
      });
      if (effort)
        await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
      this.timing("cli-initialized");
      if (this.input.beforeTurn) {
        // Cancellation or failure while waiting settles `done`; never start a turn afterwards.
        await Promise.race([this.input.beforeTurn(), done]);
        if (this.cancelled || this.terminal) return;
        this.timing("turn-admitted");
      }
      // History and page context travel in the prompt envelope: one user message per Run.
      this.turnStarted = true;
      await this.write({
        type: "user",
        message: {
          role: "user",
          content: [
            ...(this.input.contextData ?? []).map(text => ({ type: "text", text })),
            ...turn.map(item => ({ type: "text", text: item.text }))
          ]
        },
        parent_tool_use_id: null,
        session_id: ""
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

  /** Interrupt a running turn and wait briefly for its result; the process is stopped anyway. */
  async cancel(): Promise<void> {
    const wasCancelled = this.cancelled;
    this.cancelled = true;
    if (!wasCancelled && this.turnStarted && !this.terminal && !this.disposal) {
      const ended = new Promise<void>(resolve => this.once("terminal", resolve));
      const id = `interrupt_${++this.nextId}`;
      void this.write({
        type: "control_request",
        request_id: id,
        request: { subtype: "interrupt" }
      })
        .then(() => this.timing("interrupt-sent"))
        .catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        ended,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, this.interruptGraceMs);
        })
      ]);
      clearTimeout(timer);
    }
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
    this.emit("terminal");
    this.finished?.();
  }

  private fail(error: Error, code = "HARNESS_FAILURE"): void {
    this.end("run.failed", { code });
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
    // Serialized writes with a bounded queue, as in the Codex Driver.
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

  /** Send a control request and wait for its success reply; the reply body is never read (the
   * MCP status reply, for one, echoes the expanded tool credential). */
  private control(request: Record<string, unknown>): Promise<void> {
    if (this.terminal) return Promise.reject(new Error("Run already terminal"));
    const id = `req_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Harness request timed out"));
      }, CONTROL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ type: "control_request", request_id: id, request }).catch(error => {
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
    if (this.outputBytes > OUTPUT_LIMIT) {
      this.fail(new Error("Run output limit"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      if (index > FRAME_LIMIT) {
        this.fail(new Error("Frame limit"));
        return;
      }
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.fail(new Error("Invalid Harness frame"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.fail(new Error("Invalid Harness frame"));
        return;
      }
      this.message(value as Line);
      if (this.terminal) return;
    }
    if (this.buffer.length > FRAME_LIMIT) this.fail(new Error("Frame limit"));
  }

  private message(line: Line): void {
    switch (line.type) {
      case "control_response":
        this.controlResponse(line.response);
        return;
      case "control_request":
        // Permission prompts, hooks and SDK MCP servers are not offered: refuse, never hang.
        if (typeof line.request_id === "string")
          void this.write({
            type: "control_response",
            response: { subtype: "error", request_id: line.request_id, error: "Not supported" }
          }).catch(() => this.fail(new Error("Harness response failed")));
        return;
      case "system":
        this.system(line);
        return;
      case "stream_event":
        if (line.parent_tool_use_id !== null) return;
        this.streamEvent(line.event);
        return;
      case "assistant":
      case "user":
        if (line.parent_tool_use_id !== null) return;
        this.toolActivity(line.type, line.message);
        return;
      case "result":
        this.result(line);
        return;
      default:
        // keep_alive, rate limit notices, tool progress and other informational lines.
        return;
    }
  }

  private controlResponse(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const response = raw as Line;
    const id = response.request_id;
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!pending || typeof id !== "string") return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (response.subtype === "success") pending.resolve();
    else pending.reject(new Error("Harness request rejected"));
  }

  private system(line: Line): void {
    if (line.subtype === "init") {
      // Session started for the turn: only the gateway's MCP tools and the web tools the
      // gateway governs, every MCP server connected and nothing allowed without a rule.
      // Anything else must not run on.
      const tools = line.tools;
      const servers = line.mcp_servers;
      if (
        line.permissionMode !== "dontAsk" ||
        !Array.isArray(tools) ||
        tools.some(
          tool =>
            typeof tool !== "string" ||
            (!tool.startsWith("mcp__") && !CLAUDE_CODE_WEB_FUNCTIONS.includes(tool))
        ) ||
        !Array.isArray(servers) ||
        servers.some(
          server => !server || typeof server !== "object" || server.status !== "connected"
        )
      ) {
        this.timing("session-rejected");
        this.fail(new Error("Unexpected Harness session"));
        return;
      }
      this.timing("session-ready");
    } else if (line.subtype === "api_retry") this.timing("model-retry");
  }

  private streamEvent(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const event = raw as Line;
    if (event.type !== "content_block_delta") return;
    const delta = event.delta as Line | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text)
      this.emitEvent("message.delta", { delta: delta.text });
  }

  /** Tool calls arrive complete in assistant messages; their results in user messages. */
  private toolActivity(type: "assistant" | "user", raw: unknown): void {
    const content = raw && typeof raw === "object" ? (raw as Line).content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const part = block as Line;
      if (
        type === "assistant" &&
        (part.type === "tool_use" || part.type === "server_tool_use") &&
        typeof part.id === "string"
      ) {
        // WebSearch runs the provider's web search through the gateway (server_tool_use
        // `web_search` when the provider's blocks surface directly).
        const item =
          part.name === "WebSearch" ||
          (part.type === "server_tool_use" && part.name === "web_search")
            ? webSearchActivity(part.id, "inProgress", {
                query: (part.input as Line | undefined)?.query
              })
            : part.type === "tool_use"
              ? toolCallSummary(part.id, part.name, part.input)
              : undefined;
        if (!item || this.tools.has(part.id) || this.tools.size >= 1024) continue;
        this.tools.set(part.id, item);
        this.emitEvent("item.started", { item: { ...item, status: "inProgress" } });
      } else if (
        (type === "user" && part.type === "tool_result") ||
        (type === "assistant" && part.type === "web_search_tool_result")
      ) {
        const id = part.tool_use_id;
        const item = typeof id === "string" ? this.tools.get(id) : undefined;
        if (!item || typeof id !== "string") continue;
        this.tools.delete(id);
        const failed =
          part.is_error === true ||
          (part.type === "web_search_tool_result" &&
            !!part.content &&
            !Array.isArray(part.content) &&
            (part.content as Line).type === "web_search_tool_result_error");
        this.emitEvent("item.completed", {
          item: { ...item, status: failed ? "failed" : "completed" }
        });
      }
    }
  }

  private result(line: Line): void {
    if (this.cancelled) {
      this.end("run.cancelled");
      return;
    }
    const usage = usageOf(line.usage);
    const data = usage ? { usage } : {};
    if (line.subtype === "success" && line.is_error !== true) this.end("run.completed", data);
    else
      this.end("run.failed", {
        ...data,
        // The CLI's own classification (e.g. api_error, max_turns); never its message text.
        code:
          typeof line.terminal_reason === "string" &&
          /^[a-z][a-z0-9_]{0,63}$/.test(line.terminal_reason)
            ? `HARNESS_${line.terminal_reason.toUpperCase()}`
            : "HARNESS_FAILURE"
      });
  }
}

/** Total input (uncached plus cache writes and reads) and output tokens of the turn. */
function usageOf(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Line;
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  return {
    input_tokens:
      count(usage.input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.cache_read_input_tokens),
    output_tokens: count(usage.output_tokens)
  };
}

const SUMMARY_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** Sanitized activity summary, same shape as the Codex Driver's: MCP server, tool, status and the
 * `api_code` (or `code`) argument only. Arguments and results never leave here. */
function toolCallSummary(
  id: string,
  name: unknown,
  input: unknown
): Record<string, unknown> | undefined {
  const pick = (value: unknown) =>
    typeof value === "string" && SUMMARY_TEXT.test(value) ? value : undefined;
  const match = typeof name === "string" ? /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name) : null;
  const server = pick(match?.[1]);
  const tool = pick(match?.[2]);
  if (!pick(id) || !server || !tool) return undefined;
  const args = input && typeof input === "object" ? (input as Line) : undefined;
  const apiCode = args ? pick(args.api_code ?? args.code) : undefined;
  return {
    type: "mcpToolCall",
    id,
    server,
    tool,
    ...(apiCode ? { arguments: { api_code: apiCode } } : {})
  };
}
