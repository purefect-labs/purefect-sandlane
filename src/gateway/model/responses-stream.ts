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
/** Bounded Responses SSE decoding only. Authorization, accounting and publication belong to Gateway.
 * In particular, receiving response.completed is not permission to publish success before accounting.
 */
import type { ResponsesEvent } from "../../spi/model-upstream.js";

export type { ResponsesEvent };

export const FRAME_LIMIT = 128 * 1024;
const STREAM_LIMIT = 4 * 1024 * 1024;
const EVENT_LIMIT = 8192;

export class ResponsesStreamError extends Error {
  constructor() {
    super("MODEL_STREAM_INVALID");
  }
}

/** SSE framing shared by the entry codecs. Delimit CR, LF and CRLF even when network chunks split
 * either UTF-8 or the CRLF pair. */
export class EventFrames {
  private line = "";
  private skipLf = false;
  private name = "";
  private data: string[] = [];
  private bytes = 0;

  *push(text: string): Generator<{ name: string; data: string }> {
    for (const char of text) {
      if (this.skipLf) {
        this.skipLf = false;
        if (char === "\n") continue;
      }
      if (char !== "\r" && char !== "\n") {
        this.line += char;
        this.bytes += Buffer.byteLength(char);
        if (this.bytes > FRAME_LIMIT) throw new ResponsesStreamError();
        continue;
      }
      this.skipLf = char === "\r";
      const line = this.line;
      this.line = "";
      if (line === "") {
        if (this.data.length) yield { name: this.name, data: this.data.join("\n") };
        this.name = "";
        this.data = [];
        this.bytes = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "event") this.name = value;
        else if (field === "data") this.data.push(value);
        // id/retry and unknown SSE fields cannot authorize a reconnect or request replay.
      }
    }
  }

  finish(): void {
    // Partial final frames are not evidence of completion, even if they look like valid JSON.
    if (this.line || this.data.length || this.name) throw new ResponsesStreamError();
  }
}

/** Strict JSON event sequence; EOF and [DONE] alone never mean successful model completion.
 * A caller can stop consuming after durable terminal handling; finally cancels the upstream reader.
 */
export async function* readResponsesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<ResponsesEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frames = new EventFrames();
  let size = 0;
  let count = 0;
  let terminal = false;
  let marker = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > STREAM_LIMIT) throw new ResponsesStreamError();
      for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
        if (frame.data === "[DONE]") {
          if (!terminal || marker) throw new ResponsesStreamError();
          marker = true;
          continue;
        }
        if (terminal || ++count > EVENT_LIMIT) throw new ResponsesStreamError();
        const value: unknown = JSON.parse(frame.data);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new ResponsesStreamError();
        const event = value as Record<string, unknown>;
        if (
          typeof event.type !== "string" ||
          !/^(response\.[a-z_]+(?:\.[a-z_]+)*|error)$/.test(event.type) ||
          (frame.name && frame.name !== event.type) ||
          event.sequence_number !== count - 1
        )
          throw new ResponsesStreamError();
        terminal = [
          "response.completed",
          "response.failed",
          "response.incomplete",
          "error"
        ].includes(event.type);
        yield Object.freeze(event) as ResponsesEvent;
      }
    }
    decoder.decode(); // Reject an incomplete trailing UTF-8 code point.
    frames.finish();
    if (!terminal) throw new ResponsesStreamError();
  } catch {
    // Provider error text, URLs and payloads must not escape through parser diagnostics.
    throw new ResponsesStreamError();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
