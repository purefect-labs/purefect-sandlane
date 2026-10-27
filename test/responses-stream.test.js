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
import test from "node:test";
import assert from "node:assert/strict";
import { readResponsesEvents } from "../dist/gateway/model/responses-stream.js";

function stream(bytes, width = bytes.length) {
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(cursor, cursor + width));
      cursor += width;
    }
  });
}
const frame = (type, sequence_number, extra = {}) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, sequence_number, ...extra })}\r\n\r\n`;
const collect = async (body, signal = new AbortController().signal) => {
  const values = [];
  for await (const event of readResponsesEvents(body, signal)) values.push(event);
  return values;
};

test("Responses SSE survives each byte boundary, CRLF and Unicode; DONE is only a trailer", async () => {
  const input = Buffer.from(
    ": heartbeat\r\n\r\n" +
      frame("response.created", 0) +
      frame("response.output_text.delta", 1, { delta: "你好🙂" }) +
      frame("response.completed", 2) +
      "data: [DONE]\n\n"
  );
  const events = await collect(stream(input, 1));
  assert.equal(events.length, 3);
  assert.equal(events[1].delta, "你好🙂");
});

for (const [name, input] of [
  ["EOF without terminal", frame("response.created", 0)],
  ["DONE without terminal", "data: [DONE]\n\n"],
  ["truncated frame", frame("response.completed", 0).slice(0, -2)],
  ["sequence gap", frame("response.completed", 1)],
  [
    "event type mismatch",
    'event: response.completed\ndata: {"type":"response.created","sequence_number":0}\n\n'
  ],
  ["after terminal", frame("response.completed", 0) + frame("response.output_text.delta", 1)],
  ["frame overflow", ":" + "x".repeat(128 * 1024) + "\n\n"],
  ["invalid UTF-8", Buffer.from([0xff])]
]) {
  test(`Responses SSE rejects ${name} with sanitized diagnostics`, async () => {
    await assert.rejects(collect(stream(Buffer.from(input))), { message: "MODEL_STREAM_INVALID" });
  });
}

test("Responses SSE abort cancels an idle provider stream", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const reading = collect(
    new ReadableStream({
      cancel() {
        cancelled = true;
      }
    }),
    abort.signal
  );
  abort.abort();
  await assert.rejects(reading, { message: "MODEL_STREAM_INVALID" });
  assert.equal(cancelled, true);
});

test("Responses SSE early consumer exit closes the upstream body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(frame("response.created", 0)));
    },
    cancel() {
      cancelled = true;
    }
  });
  for await (const event of readResponsesEvents(body, new AbortController().signal)) {
    assert.equal(event.type, "response.created");
    break;
  }
  assert.equal(cancelled, true);
});
