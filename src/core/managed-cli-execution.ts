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
import type { HarnessDriver, RunInput, RuntimeEvent } from "../spi/harness.js";

/** Answer budget in JSON-escaped UTF-8 bytes: keeps the final result envelope (answer plus
 * error/usage) well under the Engine's 256KB limit. */
export const MAX_ANSWER_BYTES = 200_000;
/** Tool-call activity is bounded separately; text deltas never count against it. */
const MAX_ITEM_EVENTS = 1024;

type Terminal = "run.completed" | "run.failed" | "run.cancelled";

/** Ephemeral Driver observations. A Host crash discards them and must never replay the prompt. */
export class ManagedCliExecution {
  /** Observations not yet taken by the consumer; adjacent text deltas are coalesced here. */
  private pending: RuntimeEvent[] = [];
  private text = "";
  private bytes = 0;
  private received = 0;
  private items = 0;
  private sequence = 0;
  private overflow = false;
  private valid = true;
  private terminal: Terminal | undefined;
  private settled = false;
  private readonly completion: Promise<void>;

  constructor(
    private readonly driver: HarnessDriver,
    private readonly input: RunInput,
    onReady: () => void = () => {}
  ) {
    let firstText = true;
    driver.on("event", event => {
      if (!this.valid) return;
      if (
        this.terminal ||
        event.schemaVersion !== 1 ||
        event.runId !== input.runId ||
        event.sequence !== this.received + 1
      ) {
        this.invalidate();
        return;
      }
      this.received++;
      if (event.type === "item.started" || event.type === "item.completed") {
        // Already a bounded summary from the Driver; keep a defensive copy only.
        const item = event.data.item;
        if (
          ++this.items > MAX_ITEM_EVENTS ||
          !item ||
          typeof item !== "object" ||
          JSON.stringify(item).length > 2048
        ) {
          this.invalidate();
          return;
        }
        this.push(event.type, { item: JSON.parse(JSON.stringify(item)) as unknown });
      } else if (event.type === "message.delta") {
        const delta = event.data.delta;
        if (typeof delta !== "string" || /[\uD800-\uDFFF]/u.test(delta)) {
          this.invalidate();
          return;
        }
        // A long answer stops growing at the budget; the Run still finishes normally.
        const accepted = this.overflow ? "" : this.fit(delta);
        if (!accepted) return;
        this.text += accepted;
        const last = this.pending.at(-1);
        if (last?.type === "message.delta")
          this.pending[this.pending.length - 1] = this.normalized(
            "message.delta",
            { delta: String(last.data.delta) + accepted },
            last.sequence
          );
        else this.push("message.delta", { delta: accepted });
        if (firstText) {
          firstText = false;
          onReady();
        }
      } else if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        this.terminal = event.type;
      } else {
        this.invalidate();
      }
    });
    this.completion = Promise.resolve()
      .then(() => driver.execute(input))
      .catch(() => this.invalidate())
      .finally(() => {
        this.settled = true;
        onReady();
      });
  }

  get done(): boolean {
    return this.settled;
  }

  /** Whether the answer reached MAX_ANSWER_BYTES and later text was dropped. */
  get truncated(): boolean {
    return this.overflow;
  }

  /** Normalized observations (text deltas and tool-call activity) since the previous call, in
   * order. Empty once the output is invalid. */
  take(): readonly RuntimeEvent[] {
    const taken = this.pending;
    this.pending = [];
    return this.valid ? taken : [];
  }

  /** A normalized prefix for preview delivery; never a terminal receipt. */
  get preview(): string | undefined {
    return this.valid ? this.text : undefined;
  }

  /** The Driver's terminal observation, once execution settled with valid output. */
  get result(): RuntimeEvent | undefined {
    return this.settled && this.valid && this.terminal
      ? this.normalized(this.terminal, {}, this.sequence + 1)
      : undefined;
  }

  async cancel(): Promise<void> {
    await this.driver.cancel();
    await this.completion;
  }

  /** A system/admission failure is not a user cancellation and cannot publish successful output. */
  async fail(): Promise<void> {
    this.invalidate();
    await this.cancel();
  }

  /** Longest code point prefix of `delta` that fits the remaining answer budget. */
  private fit(delta: string): string {
    const cost = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
    const whole = cost(delta);
    if (this.bytes + whole <= MAX_ANSWER_BYTES) {
      this.bytes += whole;
      return delta;
    }
    this.overflow = true;
    let prefix = "";
    for (const char of delta) {
      const next = cost(char);
      if (this.bytes + next > MAX_ANSWER_BYTES) break;
      this.bytes += next;
      prefix += char;
    }
    return prefix;
  }

  private push(type: RuntimeEvent["type"], data: Record<string, unknown>): void {
    this.pending.push(this.normalized(type, data, ++this.sequence));
  }

  /** Copy only normalized fields; diagnostic data and mutable adapter objects never persist. */
  private normalized(
    type: RuntimeEvent["type"],
    data: Record<string, unknown>,
    sequence: number
  ): RuntimeEvent {
    return Object.freeze({
      schemaVersion: 1,
      runId: this.input.runId,
      sequence,
      type,
      data: Object.freeze(data)
    });
  }

  private invalidate(): void {
    this.valid = false;
    this.pending = [];
    this.text = "";
  }
}
