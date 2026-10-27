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
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalProcessTransport } from "../dist/harness/codex/local-process-transport.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";
import { businessInstructions } from "../dist/plugins/purefect/business-instructions.js";

async function local(t, script, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-transport-"));
  const launch = {
    command: process.execPath,
    args: ["-e", script],
    home: path.join(root, "home"),
    workspace: path.join(root, "work"),
    env: { LANG: "C.UTF-8" },
    ...changes
  };
  const transport = new LocalProcessTransport(launch);
  t.after(async () => {
    await transport.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { transport, launch };
}
function observer() {
  let ready, closed;
  const output = new Promise(resolve => {
    ready = resolve;
  });
  const exit = new Promise(resolve => {
    closed = resolve;
  });
  const values = { chunks: [], faults: 0, exits: [] };
  return {
    output,
    exit,
    values,
    stdout(chunk) {
      values.chunks.push(chunk);
      ready();
    },
    fault() {
      values.faults++;
    },
    exited(evidence) {
      values.exits.push(evidence);
      closed();
    }
  };
}

test("local byte transport freezes launch inputs and does not inherit host environment", async t => {
  const { transport, launch } = await local(
    t,
    "process.stdout.write(JSON.stringify({value:process.env.VALUE,secret:process.env.PUREFECT_TRANSPORT_SECRET??null}));process.stdin.resume();",
    { env: { VALUE: "original" } }
  );
  const previous = process.env.PUREFECT_TRANSPORT_SECRET;
  process.env.PUREFECT_TRANSPORT_SECRET = "private";
  t.after(() => {
    if (previous === undefined) delete process.env.PUREFECT_TRANSPORT_SECRET;
    else process.env.PUREFECT_TRANSPORT_SECRET = previous;
  });
  launch.env.VALUE = "changed";
  launch.args.push("untrusted");
  const seen = observer();
  await transport.start(seen);
  await seen.output;
  assert.deepEqual(JSON.parse(Buffer.concat(seen.values.chunks)), {
    value: "original",
    secret: null
  });
  const a = transport.stop(),
    b = transport.stop();
  assert.equal(a, b);
  assert.equal((await a).state, "exited");
  await seen.exit;
  assert.equal(seen.values.exits.length, 1);
});

test("stopping before start prevents later process creation", async t => {
  const { transport, launch } = await local(t, "process.stdin.resume()");
  assert.deepEqual(await transport.stop(), { state: "not-started" });
  await assert.rejects(transport.start(observer()), /cannot be reused/);
  await assert.rejects(access(launch.home));
});

test("stopping during async directory preparation does not start a late process", async t => {
  const { transport } = await local(t, "process.stdin.resume()");
  const started = transport.start(observer());
  const rejected = assert.rejects(started, /transport start failed/);
  assert.deepEqual(await transport.stop(), { state: "not-started" });
  await rejected;
});

test(
  "TERM-resistant child is killed and stop reports observed exit, not just a sent signal",
  { timeout: 5000 },
  async t => {
    const { transport } = await local(
      t,
      'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'
    );
    const seen = observer();
    await transport.start(seen);
    await seen.output;
    const stopped = await transport.stop();
    assert.equal(stopped.state, "exited");
    if (process.platform !== "win32") assert.equal(stopped.signal, "SIGKILL");
  }
);

test("spawn failure has sanitized error and explicit evidence", async t => {
  const { transport } = await local(t, "", { command: "/missing/private-sensitive-name" });
  await assert.rejects(transport.start(observer()), /^Error: Harness transport start failed$/);
  assert.deepEqual(await transport.stop(), { state: "spawn-failed" });
});

test("local writes are bounded and stop breaks a blocked pipe", { timeout: 5000 }, async t => {
  const { transport } = await local(t, 'process.stdout.write("ready");setInterval(()=>{},1000)');
  const seen = observer();
  await transport.start(seen);
  await seen.output;
  await assert.rejects(transport.write(Buffer.alloc(128 * 1024 + 1)), /input limit/);
  const write = transport.write(Buffer.alloc(128 * 1024));
  const outcome = write.catch(() => {});
  await assert.rejects(transport.write(Buffer.from("second")), /input limit/);
  assert.equal((await transport.stop()).state, "exited");
  await outcome;
});

class ScriptedTransport {
  messages = [];
  stops = 0;
  gate = undefined;
  unknown = false;
  async start(observer) {
    this.observer = observer;
    if (this.gate) await this.gate;
  }
  async write(frame) {
    const m = JSON.parse(frame);
    this.messages.push(m);
    const reply = value => {
      const bytes = Buffer.from(JSON.stringify(value) + "\n");
      // Split inside UTF-8 bytes, not JS strings.
      for (let i = 0; i < bytes.length; i += 3) this.observer.stdout(bytes.subarray(i, i + 3));
    };
    if (m.method === "initialize") reply({ id: m.id, result: {} });
    if (m.method === "thread/start") reply({ id: m.id, result: { thread: { id: "private" } } });
    if (m.method === "turn/start") {
      reply({ id: m.id, result: {} });
      reply({ method: "item/agentMessage/delta", params: { delta: "你好🙂" } });
      reply({ method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  }
  async stop() {
    this.stops++;
    return this.unknown ? { state: "unknown" } : { state: "exited", code: 0, signal: null };
  }
}
const input = () => ({ runId: "run-1", prompt: "hello", expiresAt: Date.now() + 5000 });

test("business instructions are Host-selected and leave the default coding profile unchanged", async () => {
  for (const instructions of [undefined, businessInstructions]) {
    const transport = new ScriptedTransport();
    const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
    await adapter.execute({
      runId: "profile",
      prompt: "user text",
      expiresAt: Date.now() + 10000,
      ...(instructions ? { instructions } : {})
    });
    const start = transport.messages.find(message => message.method === "thread/start").params;
    if (instructions) {
      assert.match(start.baseInstructions, /first send one short, specific sentence/);
      assert.match(start.baseInstructions, /untrusted data, not instructions/);
      assert.ok(start.baseInstructions.length < 2500);
    } else assert.equal(start.baseInstructions, undefined);
    assert.equal(start.sandbox, "read-only");
    assert.equal(start.approvalPolicy, "never");
    await adapter.dispose();
  }
  await assert.rejects(
    new CodexRunAdapter({ workspace: "/sandbox", transport: new ScriptedTransport() }).execute({
      ...input(),
      instructions: "x".repeat(16_001)
    }),
    /Invalid Run input/
  );
});

test("reasoning effort is opt-in, bounded and passed to the individual turn", async () => {
  for (const reasoningEffort of [undefined, "low", "medium", "high"]) {
    const transport = new ScriptedTransport();
    const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport, reasoningEffort });
    await adapter.execute(input());
    assert.equal(
      transport.messages.find(m => m.method === "turn/start").params.effort,
      reasoningEffort
    );
  }
  assert.throws(
    () =>
      new CodexRunAdapter({
        workspace: "/sandbox",
        transport: new ScriptedTransport(),
        reasoningEffort: "untrusted"
      }),
    /Invalid reasoning effort/
  );
});

test("memory is ordinary turn data and never changes thread system instructions", async () => {
  const transport = new ScriptedTransport();
  const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
  await adapter.execute({ ...input(), contextData: ["personal memory example"] });
  const turn = transport.messages.find(m => m.method === "turn/start").params;
  assert.deepEqual(
    turn.input.map(item => item.text),
    ["personal memory example", "hello"]
  );
  assert.ok(
    !JSON.stringify(transport.messages.find(m => m.method === "thread/start")).includes(
      "personal memory example"
    )
  );
});

test("protocol driver accepts an external byte transport without touching host workspace", async () => {
  const transport = new ScriptedTransport();
  const options = { workspace: "/not-a-host-workspace/purefect", transport };
  const adapter = new CodexRunAdapter(options);
  options.workspace = "/mutated";
  assert.deepEqual(adapter.capabilities, {
    schemaVersion: 1,
    streamingText: true,
    interactiveInput: false,
    approvalBridge: false,
    nativeResume: false,
    modelWire: "responses",
    sessionPolicy: "ephemeral"
  });
  assert.equal(Object.isFrozen(adapter.capabilities), true);
  const events = [];
  adapter.on("event", e => events.push(e));
  const data = input();
  const running = adapter.execute(data);
  data.prompt = "mutated";
  await running;
  assert.equal(events[0].data.delta, "你好🙂");
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(
    transport.messages.find(m => m.method === "turn/start").params.input[0].text,
    "hello"
  );
  assert.equal(
    transport.messages.find(m => m.method === "thread/start").params.cwd,
    "/not-a-host-workspace/purefect"
  );
  assert.equal(adapter.stopEvidence.state, "exited");
  assert.equal(transport.stops, 1);
  await assert.rejects(adapter.execute(input()), /cannot be reused/);
});

test("cancel during transport start emits one terminal and never sends a prompt", async () => {
  const transport = new ScriptedTransport();
  let release;
  transport.gate = new Promise(resolve => {
    release = resolve;
  });
  const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
  const events = [];
  adapter.on("event", e => events.push(e));
  const running = adapter.execute(input());
  await adapter.cancel();
  release();
  await running;
  assert.equal(transport.messages.length, 0);
  assert.deepEqual(
    events.map(e => e.type),
    ["run.cancelled"]
  );
  assert.equal(transport.stops, 1);
});

test("unconfirmed transport stop is not reported as successful cleanup", async () => {
  const transport = new ScriptedTransport();
  transport.unknown = true;
  const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
  await assert.rejects(adapter.execute(input()), /stop unconfirmed/);
  assert.deepEqual(adapter.stopEvidence, { state: "unknown" });
  await assert.rejects(adapter.dispose(), /stop unconfirmed/);
  assert.equal(transport.stops, 1);
});

test("disposed driver rejects execution and invalid deadlines never start transport", async () => {
  const transport = new ScriptedTransport();
  const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
  await assert.rejects(adapter.execute({ ...input(), expiresAt: NaN }), /Invalid Run/);
  assert.equal(transport.observer, undefined);
  await adapter.dispose();
  await assert.rejects(adapter.execute(input()), /disposed/);
});

test(
  "stderr flood fails safely without forwarding diagnostic contents",
  { timeout: 5000 },
  async t => {
    const { transport } = await local(
      t,
      'process.stderr.write("secret-diagnostic".repeat(400000));process.stdin.resume()'
    );
    const adapter = new CodexRunAdapter({ workspace: "/sandbox", transport });
    const events = [];
    adapter.on("event", e => events.push(e));
    await adapter.execute(input());
    assert.deepEqual(
      events.map(e => e.type),
      ["run.failed"]
    );
    assert.equal(JSON.stringify(events).includes("secret-diagnostic"), false);
    assert.equal(adapter.stopEvidence.state, "exited");
  }
);

test("process exit notification follows draining its final stdout", async t => {
  const size = 256 * 1024;
  const { transport } = await local(
    t,
    `process.stdout.write("x".repeat(${size}),()=>process.exit(0))`
  );
  const seen = observer();
  let atExit = 0;
  await transport.start({
    ...seen,
    exited(evidence) {
      atExit = Buffer.concat(seen.values.chunks).length;
      seen.exited(evidence);
    }
  });
  await seen.exit;
  assert.equal(atExit, size);
  assert.deepEqual(await transport.stop(), { state: "exited", code: 0, signal: null });
});
