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
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SqliteMemoryStore } from "../dist/plugins/memory/sqlite-store.js";
import { ConversationSummaries } from "../dist/plugins/memory/summary.js";
import { HttpSummarizer } from "../dist/plugins/memory/http-summarizer.js";
import { MemoryContextProvider } from "../dist/plugins/memory/context-provider.js";
import { openLocalMemory } from "../dist/plugins/memory/runtime.js";

const scope = { tenantId: "one", userId: "alice" };
const signal = () => new AbortController().signal;
const source = { conversationId: "chat", runId: "run", messageId: "message", revision: "1" };
const remember = (store, text, key = "remember") =>
  store.remember({
    scope,
    source,
    text,
    kind: "preference",
    idempotencyKey: key,
    signal: signal()
  });
const context = (count = 8, start = 1) => ({
  conversationId: "chat",
  beforeRun: count + start,
  omittedTurns: start - 1,
  turns: Array.from({ length: count }, (_, n) => ({
    run: start + n,
    status: "COMPLETED",
    user: `question-${n + start}`,
    assistant: "answer",
    truncated: false
  }))
});
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pf-memory-test-"));
  const filename = path.join(directory, "test.sqlite");
  const store = new SqliteMemoryStore(filename);
  t.after(async () => {
    try {
      store.close();
    } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  return { store, filename };
}

test("explicit cards persist across a new store and isolate tenant, user and assignment", async t => {
  const { store, filename } = await fixture(t);
  const result = await remember(store, "Use Chinese");
  assert.equal(result.state, "completed");
  const other = new SqliteMemoryStore(filename);
  try {
    assert.equal(other.list(scope)[0].text, "Use Chinese");
    for (const owner of [
      { ...scope, tenantId: "two" },
      { ...scope, userId: "bob" },
      { ...scope, assignmentId: "job" }
    ]) {
      assert.deepEqual(other.list(owner), []);
      await assert.rejects(
        other.operation({ scope: owner, operationId: "remember", signal: signal() }),
        /NOT_FOUND/
      );
    }
  } finally {
    other.close();
  }
});

test("same mutation retries once, conflicting reuse and stale correction fail", async t => {
  const { store } = await fixture(t);
  const saved = await remember(store, "Use Chinese");
  assert.deepEqual(await remember(store, "Use Chinese"), saved);
  await assert.rejects(remember(store, "different"), /REQUEST_CONFLICT/);
  const update = {
    scope,
    id: saved.recordId,
    expectedRevision: "1",
    text: "Use English",
    idempotencyKey: "edit",
    signal: signal()
  };
  assert.equal((await store.correct(update)).revision, "2");
  assert.equal((await store.correct(update)).revision, "2");
  await assert.rejects(store.correct({ ...update, idempotencyKey: "stale" }), /REVISION_CONFLICT/);
});

test("deletion removes the body and replayed writes do not resurrect it", async t => {
  const { store } = await fixture(t);
  const saved = await remember(store, "Unique sensitive fact");
  await store.forget({
    scope,
    selector: { ids: [saved.recordId] },
    deletionVersion: "2",
    idempotencyKey: "delete",
    signal: signal()
  });
  await remember(store, "Unique sensitive fact");
  assert.deepEqual(store.list(scope), []);
  const operation = store.database.prepare("SELECT result FROM memory_operation").all();
  assert.ok(!JSON.stringify(operation).includes("Unique sensitive fact"));
  await assert.rejects(
    store.ingest({
      scope,
      source,
      messages: [{ role: "user", text: "secret" }],
      idempotencyKey: "auto",
      signal: signal()
    }),
    /EXPLICIT_WRITE_REQUIRED/
  );
});

test("capacity is explicit, scoped and freed by delete; no silent dropping", async t => {
  const { store } = await fixture(t);
  for (let n = 0; n < 8; n++) await remember(store, "a".repeat(500), `card-${n}`);
  await assert.rejects(remember(store, "overflow", "overflow"), /CAPACITY/);
  await assert.rejects(remember(store, "a".repeat(501), "large"), /TEXT_LIMIT/);
  await store.forget({
    scope,
    selector: { all: true },
    deletionVersion: "2",
    idempotencyKey: "clear",
    signal: signal()
  });
  for (let n = 0; n < 20; n++) await remember(store, `small-${n}`, `small-${n}`);
  await assert.rejects(remember(store, "overflow", "count-overflow"), /CAPACITY/);
  const page = await store.export({ scope, limit: 10, signal: signal() });
  const next = await store.export({ scope, cursor: page.nextCursor, limit: 10, signal: signal() });
  assert.equal(new Set([...page.records, ...next.records].map(r => r.id)).size, 20);
});

test("summary queue persists without a model call, and workers atomically claim one job", async t => {
  const { store, filename } = await fixture(t);
  const queue = new ConversationSummaries(store);
  assert.equal(queue.enqueue(scope, context(7)), "not-needed");
  assert.equal(queue.enqueue(scope, context()), "queued");
  const other = new SqliteMemoryStore(filename);
  const recovery = new ConversationSummaries(other);
  let finish;
  const running = queue.tick(
    {
      summarize: () =>
        new Promise(resolve => {
          finish = resolve;
        })
    },
    signal()
  );
  assert.equal(
    await recovery.tick(
      {
        summarize: async () => {
          throw Error("duplicate");
        }
      },
      signal()
    ),
    false
  );
  finish("Goal: build reports; constraints: Chinese");
  await running;
  assert.equal(recovery.read(scope, "chat").throughRun, 4);
  assert.equal(recovery.read({ ...scope, userId: "bob" }, "chat"), undefined);
  assert.equal(recovery.status(scope, "chat"), "idle");
  other.close();
});

test("incremental summaries cover only new turns and keep the last four raw", async t => {
  const { store } = await fixture(t);
  const queue = new ConversationSummaries(store);
  queue.enqueue(scope, context());
  await queue.tick({ summarize: async () => "summary1" }, signal());
  queue.enqueue(scope, context(12));
  await queue.tick(
    {
      summarize: async input => {
        assert.equal(input.previous, "summary1");
        assert.deepEqual(
          input.turns.map(turn => turn.run),
          [5, 6, 7, 8]
        );
        return "summary2";
      }
    },
    signal()
  );
  assert.deepEqual(queue.read(scope, "chat"), { text: "summary2", throughRun: 8, revision: 2 });
});

test("summary failure backs off, stops after three attempts, and preserves old summary", async t => {
  const { store } = await fixture(t);
  let now = 1000;
  const queue = new ConversationSummaries(store, () => now);
  queue.enqueue(scope, context());
  const fail = {
    summarize: async () => {
      throw new Error("provider failed");
    }
  };
  for (let i = 0; i < 3; i++) {
    assert.equal(await queue.tick(fail, signal()), true);
    assert.equal(await queue.tick(fail, signal()), false);
    now += 300000;
  }
  assert.equal(queue.status(scope, "chat"), "failed");
  assert.equal(queue.read(scope, "chat"), undefined);
  assert.equal(store.database.prepare("SELECT input FROM summary_job").get().input, "");
});

test("reset fences a late summarizer and prevents deleted summary resurrection", async t => {
  const { store } = await fixture(t);
  const queue = new ConversationSummaries(store);
  queue.enqueue(scope, context());
  let finish;
  const running = queue.tick(
    {
      summarize: () =>
        new Promise(resolve => {
          finish = resolve;
        })
    },
    signal()
  );
  queue.reset(scope, "chat");
  finish("stale content");
  await running;
  assert.equal(queue.read(scope, "chat"), undefined);
});

test("expired summary lease can be reclaimed; old owner cannot publish", async t => {
  const { store } = await fixture(t);
  let now = 1000;
  const queue = new ConversationSummaries(store, () => now);
  queue.enqueue(scope, context());
  let finish;
  const old = queue.tick(
    {
      summarize: () =>
        new Promise(resolve => {
          finish = resolve;
        })
    },
    signal()
  );
  now += 120001;
  await queue.tick({ summarize: async () => "new owner" }, signal());
  finish("old owner");
  await old;
  assert.equal(queue.read(scope, "chat").text, "new owner");
});

test("missing/truncated history is not silently summarized as complete", async t => {
  const { store } = await fixture(t);
  const queue = new ConversationSummaries(store);
  assert.throws(() => queue.enqueue(scope, context(8, 2)), /HISTORY_GAP/);
  const clipped = context();
  clipped.turns[0].truncated = true;
  assert.throws(() => queue.enqueue(scope, clipped), /HISTORY_GAP/);
});

test("cancelling ignored model work returns promptly and no late result is applied", async t => {
  const { store } = await fixture(t);
  const queue = new ConversationSummaries(store);
  queue.enqueue(scope, context());
  const abort = new AbortController();
  const running = queue.tick({ summarize: () => new Promise(() => {}) }, abort.signal);
  abort.abort(new Error("stopped"));
  await assert.rejects(running, /stopped/);
  assert.equal(queue.read(scope, "chat"), undefined);
});

test("HTTP summarizer has fixed routing, no tools and rejects incomplete or oversized answers", async () => {
  let sent;
  const request = async (url, options) => {
    sent = { url, ...options };
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "summary" } }] });
  };
  const model = new HttpSummarizer(
    "https://model.example/v1",
    "summary-model",
    "private-key",
    request
  );
  assert.equal(await model.summarize({ previous: null, turns: [] }, signal()), "summary");
  assert.equal(sent.url, "https://model.example/v1/chat/completions");
  assert.equal(sent.redirect, "error");
  assert.equal(JSON.parse(sent.body).tools, undefined);
  assert.throws(() => new HttpSummarizer("http://model.example/v1", "m", "key"), /CONFIGURATION/);
  for (const content of ["private-key", "a".repeat(8001)]) {
    const bad = new HttpSummarizer("https://model.example/v1", "m", "private-key", async () =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content } }] })
    );
    await assert.rejects(bad.summarize({ previous: null, turns: [] }, signal()));
  }
});

/** Inner ContextProvider returning a fixed turn; the request carries the lease scope. */
const base = (prompt, promptFormat = "text") => ({
  turn: async () => ({ prompt, promptFormat })
});
const request = (runId, conversationId = "chat", owner = scope) => ({
  runId,
  conversationId,
  tenantId: owner.tenantId,
  userId: owner.userId,
  input: { prompt: "unused", history: [] }
});

test("CLI wrapper accepts only explicit CURRENT commands and isolates saved memory", async t => {
  const { store } = await fixture(t);
  const summaries = new ConversationSummaries(store);
  const first = await new MemoryContextProvider(
    base('/memory {"action":"remember","kind":"preference","text":"Use Chinese"}'),
    store,
    summaries
  ).turn(request("r1"), signal());
  assert.match(first.contextData.join(), /Use Chinese/);
  const next = await new MemoryContextProvider(base("Hello"), store, summaries).turn(
    request("r2", "new-chat"),
    signal()
  );
  assert.match(next.contextData.join(), /Use Chinese/);
  const other = await new MemoryContextProvider(base("Hello"), store, summaries).turn(
    request("r3", "chat", { ...scope, userId: "bob" }),
    signal()
  );
  assert.deepEqual(other.contextData, []);
});

test("CLI input uses summary plus uncovered history without waiting for new summary", async t => {
  const { store } = await fixture(t);
  const summaries = new ConversationSummaries(store);
  summaries.enqueue(scope, context());
  await summaries.tick({ summarize: async () => "Earlier goals" }, signal());
  const prompt = JSON.stringify({
    version: 1,
    prompt: "continue",
    ui_context: null,
    conversation: context()
  });
  const turn = await new MemoryContextProvider(
    base(prompt, "conversation-context-v1"),
    store,
    summaries
  ).turn(request("r9"), signal());
  const assembled = JSON.parse(turn.prompt).conversation;
  assert.equal(assembled.summary.text, "Earlier goals");
  assert.deepEqual(
    assembled.turns.map(turn => turn.run),
    [5, 6, 7, 8]
  );
  assert.equal(assembled.omittedTurns, 0);
});

test("optional summary cannot break a valid nearly full history envelope", async t => {
  const { store } = await fixture(t);
  const summaries = new ConversationSummaries(store);
  summaries.enqueue(scope, context());
  await summaries.tick({ summarize: async () => "s".repeat(8000) }, signal());
  const history = context(4, 5);
  history.turns = history.turns.map(turn => ({
    ...turn,
    user: "x".repeat(7900),
    assistant: "y".repeat(1200)
  }));
  const prompt = JSON.stringify({
    version: 1,
    prompt: "continue",
    ui_context: null,
    conversation: history
  });
  const reports = [];
  const turn = await new MemoryContextProvider(
    base(prompt, "conversation-context-v1"),
    store,
    summaries,
    code => reports.push(code)
  ).turn(request("budget"), signal());
  assert.equal(turn.prompt, prompt);
  assert.ok(reports.includes("MEMORY_SUMMARY_NOT_APPLIED"));
});

test("invalid memory command reports failure and never switches owner or creates a card", async t => {
  const { store } = await fixture(t);
  const turn = await new MemoryContextProvider(
    base('/memory {"action":"remember","kind":"fact","text":"x","scope":{"userId":"bob"}}'),
    store,
    new ConversationSummaries(store)
  ).turn(request("bad-command"), signal());
  assert.match(turn.contextData[0], /"state":"failed"/);
  assert.deepEqual(store.list(scope), []);
});

test("full personal memory and list fit the actual CLI context budget including JSON escaping", async t => {
  const { store } = await fixture(t);
  for (let n = 0; n < 20; n++) await remember(store, '\\"'.repeat(40), `escaped-${n}`);
  const turn = await new MemoryContextProvider(
    base('/memory {"action":"list"}'),
    store,
    new ConversationSummaries(store)
  ).turn(request("list"), signal());
  assert.ok(Buffer.byteLength(JSON.stringify(turn.contextData)) <= 16000);
});

test("local runtime requires explicit single-host topology and private non-symlink directory", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pf-memory-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(openLocalMemory(directory, {}), /SHARED_BACKEND_REQUIRED/);
  const runtime = await openLocalMemory(directory, { SANDLANE_MEMORY_TOPOLOGY: "single-host" });
  await runtime.close();
  assert.equal((await stat(path.join(directory, "memory"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, "memory/memory.sqlite"))).mode & 0o777, 0o600);
  const linked = await mkdtemp(path.join(os.tmpdir(), "pf-memory-link-"));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await symlink(path.join(directory, "memory"), path.join(linked, "memory"));
  await assert.rejects(
    openLocalMemory(linked, { SANDLANE_MEMORY_TOPOLOGY: "single-host" }),
    /DIRECTORY_INVALID/
  );
});
