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
import { NativeSessionCache } from "../dist/core/native-session-cache.js";
import {
  nativeThread,
  nativeSnapshot,
  encodeNative,
  decodeNative,
  NATIVE_STATE_BYTES
} from "../dist/common/native-session.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";

const threadId = "01234567-1234-1234-1234-123456789abc";
const thread = {
  threadId,
  path: "/home/runner/.codex/sessions/2026/11/03/rollout-2026-11-03T12-00-00-" + threadId + ".jsonl"
};
const snapshot = () => ({
  ...thread,
  containerId: "c".repeat(64),
  brokerEpoch: "a".repeat(8) + "-" + "b".repeat(27),
  data: Buffer.from("opaque fixture")
});
const policy = (runNo, changes = {}) => ({
  key: "tenant/user/member/chat/codex",
  tenant: "tenant",
  runNo,
  fingerprint: "policy",
  contracts: { read: "v1" },
  ...changes
});

test("native cache consumes entries and publishes only when the owner commits success", t => {
  const cache = new NativeSessionCache();
  t.after(() => cache.close());
  cache.begin(policy(1)).finish(snapshot());
  const second = cache.begin(policy(2));
  assert.deepEqual(second.snapshot.data, snapshot().data);
  // An overlapping use invalidates the prior owner; neither may publish.
  assert.equal(cache.begin(policy(2)), undefined);
  second.finish(snapshot(), true);
  assert.equal(cache.begin(policy(3)).snapshot, undefined);
});
test("native cache rejects gaps, removed/changed tools, policy changes and resets", t => {
  for (const change of [
    { runNo: 3 },
    { contracts: {} },
    { contracts: { read: "v2" } },
    { fingerprint: "new" }
  ]) {
    const cache = new NativeSessionCache();
    t.after(() => cache.close());
    cache.begin(policy(1)).finish(snapshot());
    assert.equal(cache.begin(policy(2, change)).snapshot, undefined);
  }
  const cache = new NativeSessionCache();
  t.after(() => cache.close());
  const first = cache.begin(policy(1));
  cache.invalidate(policy(1).key);
  first.finish(snapshot());
  assert.equal(cache.begin(policy(2)).snapshot, undefined);
});

test("late cancellation invalidates only its own publication, never a newer Run", t => {
  const cache = new NativeSessionCache();
  t.after(() => cache.close());
  const first = cache.begin(policy(1));
  first.finish(snapshot());
  first.invalidate();
  const second = cache.begin(policy(2));
  assert.equal(second.snapshot, undefined);
  second.finish(snapshot());
  first.invalidate();
  assert.ok(cache.begin(policy(3)).snapshot);
});
test("native cache allows added tools, enforces absolute lifetime and bounds in-flight buffers", t => {
  let now = 0;
  const cache = new NativeSessionCache(() => now);
  t.after(() => cache.close());
  cache.begin(policy(1)).finish(snapshot());
  let runNo = 2;
  for (now = 240000; now < 3600000; now += 240000) {
    const use = cache.begin(policy(runNo++, { contracts: { read: "v1", extra: "v1" } }));
    assert.ok(use.snapshot);
    use.finish(snapshot(), true);
  }
  assert.equal(cache.begin(policy(runNo)).snapshot, undefined);
  const one = cache.begin(policy(1, { key: "other" }));
  assert.ok(one);
  // Two transfers of the same tenant reserve the full tenant budget.
  assert.equal(cache.begin(policy(1, { key: "third" })), undefined);
  one.finish();
});
test("native state codec rejects paths, links by path substitution, oversized and truncated bodies", () => {
  assert.deepEqual(nativeThread(thread), thread);
  for (const path of [
    "/etc/passwd",
    thread.path.replace("/sessions/", "/sessions/../"),
    thread.path + "/x"
  ])
    assert.throws(() => nativeThread({ ...thread, path }));
  assert.throws(() =>
    nativeSnapshot({ ...snapshot(), data: Buffer.alloc(NATIVE_STATE_BYTES + 1) })
  );
  const encoded = encodeNative(thread, snapshot().data);
  assert.deepEqual(decodeNative(encoded).data, snapshot().data);
  assert.throws(() => decodeNative(encoded.subarray(0, 5)));
});

function transport({ resumeError = false, version = "0.154.0", fail = false } = {}) {
  const messages = [],
    order = [];
  let observer;
  return {
    messages,
    order,
    async start(value) {
      observer = value;
    },
    async write(frame) {
      const request = JSON.parse(frame);
      messages.push(request);
      if (request.id) {
        const result =
          request.method === "initialize"
            ? { userAgent: "codex_cli_rs/" + version }
            : request.method.startsWith("thread/")
              ? { thread: { id: threadId, path: thread.path } }
              : {};
        observer.stdout(
          Buffer.from(
            JSON.stringify(
              request.method === "thread/resume" && resumeError
                ? { id: request.id, error: { code: -32600, message: "missing thread" } }
                : { id: request.id, result }
            ) + "\n"
          )
        );
      }
      if (request.method === "turn/start") {
        observer.stdout(
          Buffer.from(
            JSON.stringify({
              method: "turn/completed",
              params: {
                turn: {
                  status: fail ? "failed" : "completed",
                  error: fail ? { message: "failed" } : null
                }
              }
            }) + "\n"
          )
        );
      }
    },
    async stop() {
      order.push("stop");
      return { state: "exited", code: 0, signal: null };
    }
  };
}
test("Codex resume submits only the current turn, captures before stop, never retries resume rejection", async () => {
  const wire = transport();
  const driver = new CodexRunAdapter({ workspace: "/workspace", transport: wire });
  await driver.execute({
    runId: "r1",
    prompt: "full history",
    expiresAt: Date.now() + 10000,
    nativeSession: {
      resume: thread,
      prompt: "current only",
      promptFormat: "text",
      capture: async value => {
        assert.deepEqual(value, thread);
        wire.order.push("capture");
      }
    }
  });
  assert.equal(
    wire.messages.find(m => m.method === "turn/start").params.input[0].text,
    "current only"
  );
  assert.deepEqual(wire.order, ["capture", "stop"]);
  assert.ok(!wire.messages.some(m => m.method === "thread/start"));
  const broken = transport({ resumeError: true });
  const failed = new CodexRunAdapter({ workspace: "/workspace", transport: broken });
  await failed.execute({
    runId: "r2",
    prompt: "history",
    expiresAt: Date.now() + 10000,
    nativeSession: {
      resume: thread,
      prompt: "current",
      promptFormat: "text",
      capture: async () => assert.fail("Must not capture rejected resume")
    }
  });
  assert.ok(!broken.messages.some(m => ["turn/start", "thread/start"].includes(m.method)));
});
test("unvalidated Codex versions stay ephemeral; failed turns never capture", async () => {
  for (const options of [{ version: "0.155.0" }, { fail: true }]) {
    const wire = transport(options);
    const driver = new CodexRunAdapter({ workspace: "/workspace", transport: wire });
    await driver.execute({
      runId: "r1",
      prompt: "full history",
      expiresAt: Date.now() + 10000,
      nativeSession: {
        prompt: "current",
        promptFormat: "text",
        capture: async () => assert.fail("No capture")
      }
    });
    if (options.version) {
      assert.equal(wire.messages.find(m => m.method === "thread/start").params.ephemeral, true);
      assert.equal(
        wire.messages.find(m => m.method === "turn/start").params.input[0].text,
        "full history"
      );
    }
  }
});
