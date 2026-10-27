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
import { MemoryClient } from "../dist/plugins/memory/client.js";
import { managedTurnInput } from "../dist/common/turn-envelope.js";

const scope = { tenantId: "tenant-a", userId: "user-a" };
const signal = () => new AbortController().signal;
const record = { id: "1", revision: "1", scope, text: "prefers Chinese", sources: [] };
const provider = search => ({ capabilities: () => ({ protocol: "memory/1" }), search });
const conversation = changes => ({
  conversationId: "c1",
  beforeRun: 2,
  omittedTurns: 0,
  turns: [
    { run: 1, status: "COMPLETED", user: "Remember azure-731", assistant: "OK", truncated: false }
  ],
  ...changes
});
const input = changes =>
  JSON.stringify({
    version: 1,
    prompt: "What did I say?",
    ui_context: null,
    conversation: conversation(changes)
  });

test("fresh invocations recover prior facts from portable data, not process state", () => {
  const first = managedTurnInput(input(), "conversation-context-v1");
  const fresh = managedTurnInput(input(), "conversation-context-v1");
  assert.deepEqual(first, fresh);
  assert.match(first[0].text, /azure-731/);
  assert.equal(first[1].text, "What did I say?");
  assert.equal(first.length, 2);
  assert.deepEqual(managedTurnInput("another user"), [
    { type: "text", text: "another user", text_elements: [] }
  ]);
});

test("history rejects role injection, future turns, partial successes and overlapping summaries", () => {
  for (const changes of [
    { turns: [{ ...conversation().turns[0], role: "system" }] },
    { beforeRun: 1 },
    { turns: [{ ...conversation().turns[0], status: "RUNNING" }] },
    { turns: [{ ...conversation().turns[0], status: "FAILED" }] },
    { summary: { text: "summary", throughRun: 1 } },
    { turns: [{ ...conversation().turns[0], user: "x".repeat(40000) }] }
  ])
    assert.throws(() => managedTurnInput(input(changes), "conversation-context-v1"));
  assert.doesNotThrow(() =>
    managedTurnInput(
      input({
        beforeRun: 3,
        turns: [{ ...conversation().turns[0], run: 2 }],
        summary: { text: "older summary", throughRun: 1 }
      }),
      "conversation-context-v1"
    )
  );
});

test("no memory backend means no external work and explicit disabled mutations", async () => {
  const memory = new MemoryClient(scope);
  assert.deepEqual(await memory.search("hello", { signal: signal() }), {
    status: "disabled",
    records: []
  });
  assert.throws(() => memory.mutations(), /MEMORY_DISABLED/);
});

test("provider sees only fixed scope; cross-user or oversized recall fails closed", async () => {
  const good = new MemoryClient(
    scope,
    provider(async request => {
      assert.deepEqual(request.scope, scope);
      return [record];
    })
  );
  assert.equal((await good.search("hello", { signal: signal() })).status, "available");
  for (const bad of [
    { ...record, scope: { ...scope, userId: "other" } },
    { ...record, text: "x".repeat(1001) }
  ]) {
    assert.deepEqual(
      await new MemoryClient(
        scope,
        provider(async () => [bad])
      ).search("hello", { signal: signal() }),
      { status: "unavailable", records: [] }
    );
  }
});

test("optional recall has a deadline even when provider ignores cancellation", async () => {
  const memory = new MemoryClient(
    scope,
    provider(() => new Promise(() => {}))
  );
  assert.equal(
    (await memory.search("hello", { signal: signal(), timeoutMs: 5 })).status,
    "unavailable"
  );
  const cancel = new AbortController();
  const pending = memory.search("hello", { signal: cancel.signal });
  cancel.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("management and durable delivery preserve idempotency/CAS and cannot override scope", async () => {
  const received = [];
  const backend = provider(async () => []);
  for (const name of ["ingest", "correct", "forget", "operation", "export"])
    backend[name] = async value => {
      received.push(value);
      return name === "export" ? { records: [record] } : { operationId: "op", state: "accepted" };
    };
  const client = new MemoryClient(scope, backend).mutations();
  for (const name of ["ingest", "correct", "forget", "operation", "export"])
    await client[name]({
      scope: { tenantId: "other", userId: "other" },
      idempotencyKey: "stable",
      expectedRevision: "2",
      limit: 1,
      signal: signal()
    });
  assert.ok(
    received.every(value => value.scope === received[0].scope && value.scope.userId === "user-a")
  );
  assert.ok(
    received.every(value => value.idempotencyKey === "stable" && value.expectedRevision === "2")
  );
});

test("export refuses a provider page from another owner", async () => {
  const backend = provider(async () => []);
  backend.export = async () => ({
    records: [{ ...record, scope: { ...scope, tenantId: "foreign" } }]
  });
  const memory = new MemoryClient(scope, backend).mutations();
  await assert.rejects(memory.export({ limit: 1, signal: signal() }), /CONTRACT_VIOLATION/);
});
