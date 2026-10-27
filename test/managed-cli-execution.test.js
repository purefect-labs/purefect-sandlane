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
import { EventEmitter } from "node:events";
import { ManagedCliExecution, MAX_ANSWER_BYTES } from "../dist/core/managed-cli-execution.js";

test("first text wakes the Host once, subsequent tokens coalesce, and settlement wakes it again", async () => {
  const driver = new EventEmitter();
  let release,
    notifications = 0;
  driver.execute = async () =>
    new Promise(resolve => {
      release = resolve;
    });
  driver.cancel = async () => release();
  const execution = new ManagedCliExecution(
    driver,
    {
      runId: "run",
      prompt: "test",
      expiresAt: Date.now() + 10000
    },
    () => {
      notifications++;
    }
  );
  await new Promise(resolve => setImmediate(resolve));
  const emit = (sequence, type, data) =>
    driver.emit("event", {
      schemaVersion: 1,
      runId: "run",
      sequence,
      type,
      data
    });
  emit(1, "message.delta", { delta: "hello" });
  assert.equal(notifications, 1);
  assert.equal(execution.preview, "hello");
  emit(2, "message.delta", { delta: " world" });
  assert.equal(notifications, 1);
  emit(3, "run.completed", {});
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications, 2);
  assert.equal(execution.done, true);
});

test("system stop does not publish the Driver cancellation as a user cancellation", async () => {
  const driver = new EventEmitter();
  let release;
  driver.execute = async () =>
    new Promise(resolve => {
      release = resolve;
    });
  driver.cancel = async () => {
    driver.emit("event", {
      schemaVersion: 1,
      runId: "run",
      sequence: 1,
      type: "run.cancelled",
      data: {}
    });
    release();
  };
  const execution = new ManagedCliExecution(driver, {
    runId: "run",
    prompt: "test",
    expiresAt: Date.now() + 1000
  });
  await new Promise(resolve => setImmediate(resolve));
  await execution.fail();
  assert.equal(execution.done, true);
  assert.equal(execution.result, undefined);
});

for (const fault of ["item-limit", "sequence", "unicode", "after-terminal", "rejection"]) {
  test(`managed output fails closed on ${fault} without treating completion as stop evidence`, async () => {
    const driver = new EventEmitter();
    driver.cancel = async () => {};
    driver.execute = async () => {
      const event = {
        schemaVersion: 1,
        runId: "run",
        sequence: 1,
        type: "message.delta",
        data: { delta: "ok" }
      };
      if (fault === "unicode") event.data.delta = "\ud800";
      if (fault === "sequence") event.sequence = 2;
      driver.emit("event", event);
      let sequence = 1;
      if (fault === "item-limit")
        for (let i = 0; i < 1025; i++)
          driver.emit("event", {
            ...event,
            sequence: ++sequence,
            type: "item.started",
            data: { item: { type: "mcpToolCall", id: `c${i}` } }
          });
      driver.emit("event", { ...event, sequence: ++sequence, type: "run.completed", data: {} });
      if (fault === "after-terminal") driver.emit("event", { ...event, sequence: ++sequence });
      if (fault === "rejection") throw Error("cleanup unconfirmed");
    };
    const execution = new ManagedCliExecution(driver, {
      runId: "run",
      prompt: "test",
      expiresAt: Date.now() + 1000
    });
    assert.equal(execution.result, undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(execution.done, true);
    assert.equal(execution.result, undefined);
  });
}

function scripted(script) {
  const driver = new EventEmitter();
  let sequence = 0;
  driver.cancel = async () => {};
  driver.send = (type, data = {}) =>
    driver.emit("event", { schemaVersion: 1, runId: "run", sequence: ++sequence, type, data });
  driver.execute = async () => script(driver);
  return driver;
}

test("token-sized deltas and tool activity beyond 1024 observations still complete", async () => {
  let execution;
  const taken = [];
  const driver = scripted(async driver => {
    for (let i = 0; i < 2000; i++) driver.send("message.delta", { delta: "t" });
    taken.push(...execution.take());
    for (let i = 0; i < 400; i++) {
      driver.send("item.started", { item: { type: "mcpToolCall", id: `c${i}` } });
      driver.send("message.delta", { delta: "a" });
      driver.send("message.delta", { delta: "b" });
    }
    driver.send("run.completed");
  });
  execution = new ManagedCliExecution(driver, {
    runId: "run",
    prompt: "test",
    expiresAt: Date.now() + 10000
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(execution.done, true);
  taken.push(...execution.take());
  // Adjacent deltas that were not taken yet are coalesced; order is preserved.
  assert.equal(taken.length, 1 + 400 * 2);
  assert.deepEqual(taken[0].data, { delta: "t".repeat(2000) });
  assert.deepEqual(
    taken.slice(1, 3).map(e => [e.type, e.data.delta ?? e.data.item.id]),
    [
      ["item.started", "c0"],
      ["message.delta", "ab"]
    ]
  );
  assert.equal(execution.preview, "t".repeat(2000) + "ab".repeat(400));
  assert.equal(execution.truncated, false);
  assert.equal(execution.result.type, "run.completed");
  assert.deepEqual(execution.take(), []);
});

test("text beyond the answer budget is dropped at a code point boundary, the Run completes", async () => {
  const driver = scripted(async driver => {
    // 99_999 + 99_998 escaped bytes, then two 3-byte characters of which only the first fits.
    driver.send("message.delta", { delta: "\n".repeat(49_999) + "x" });
    driver.send("message.delta", { delta: "y".repeat(99_998) });
    driver.send("message.delta", { delta: "\u4e2d\u6587" });
    driver.send("message.delta", { delta: "after the limit" });
    driver.send("run.completed");
  });
  const execution = new ManagedCliExecution(driver, {
    runId: "run",
    prompt: "test",
    expiresAt: Date.now() + 10000
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(MAX_ANSWER_BYTES, 200_000);
  assert.equal(execution.truncated, true);
  const answer = execution.preview;
  assert.equal(answer, "\n".repeat(49_999) + "x" + "y".repeat(99_998) + "\u4e2d");
  assert.equal(Buffer.byteLength(JSON.stringify(answer)) - 2, MAX_ANSWER_BYTES);
  assert.equal(
    execution
      .take()
      .map(e => e.data.delta)
      .join(""),
    answer
  );
  assert.equal(execution.result.type, "run.completed");
});
