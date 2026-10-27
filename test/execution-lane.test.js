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
import http from "node:http";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { PapiControlPlane } from "../dist/plugins/purefect/control-plane.js";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { ExecutionLane } from "../dist/core/worker.js";
import { LocalModelAuthority } from "../dist/gateway/model/local-authority.js";
import { ModelGateway } from "../dist/gateway/model/gateway.js";
import { LocalToolAuthority } from "../dist/gateway/tool/local-authority.js";
import { ToolGateway } from "../dist/gateway/tool/gateway.js";
import { ALL_INTERACTION_OPS } from "../dist/plugins/purefect/workspace-interaction.js";

const TOOL_CATALOG = [{ alias: "metadata.get_raw", version: 1 }];
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";
import { BrokerSandboxLauncher } from "../dist/sandbox/docker/broker-sandbox.js";
import { BrokerHarnessTransport } from "../dist/sandbox/docker/broker-transport.js";
import { FrozenInputContext } from "../dist/core/turn-input.js";
import { StatusRecorder } from "../dist/status/recorder.js";

const SERVICE_SECRET = "service-secret-" + "z".repeat(40);
const AGENT_TOKEN = "agent-token-secret-" + "x".repeat(40);
const MODEL_KEY = "sk-model-secret-" + "y".repeat(40);
const SECRETS = [SERVICE_SECRET, AGENT_TOKEN, MODEL_KEY];

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function lease(changes = {}) {
  const now = Date.now();
  return {
    job_id: "101",
    generation: 1,
    lease_until: now + 30000,
    deadline_at: now + 600000,
    run: {
      run_id: "201",
      tenant_id: "7",
      conversation_id: "301",
      run_no: 2,
      execution_profile: "sandbox",
      identity: { user_id: "401", tenant_code: "acme", site: "site-a" },
      input: {
        prompt: "Hello",
        history: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hey" }
        ]
      },
      input_digest: "a".repeat(64),
      ...changes.run
    },
    credentials: {
      agent_token: { value: AGENT_TOKEN, expires_at: now + 60000 },
      model_service: {
        base_uri: "https://models.example.test/v1",
        wire_api: "responses",
        model: "gpt-test",
        api_key: MODEL_KEY
      }
    }
  };
}

/** Minimal Engine: PAPI envelope, lease proof, contiguous event offsets, actions and complete digest. */
async function fakeEngine(t, hooks = {}) {
  const state = {
    log: [],
    headers: new Set(),
    claims: [],
    syncs: [],
    completes: [],
    outputs: [],
    proposes: [],
    faults: [],
    events: [],
    actions: [],
    receipts: new Map(),
    cancel: false,
    pending: [],
    claimToken: undefined,
    tokens: 0,
    lastToken: AGENT_TOKEN,
    accepted: undefined
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const op = req.url.split("::")[1];
    state.headers.add(req.headers["x-purefect-service-token"]);
    state.log.push(op);
    assert.equal(req.url.split("::")[0], "/papi/ctl/tenant-a/pf.ai.worker.ExecutionDomain");
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const reply = data => send(200, { code: 200, success: true, data });
    const fault = (code, vars) => {
      state.faults.push(code);
      send(500, {
        code: 500,
        success: false,
        data: { fault: code, message: "rejected", ...(vars ? { error_msg_var: vars } : {}) }
      });
    };
    const ctx = { reply, fault, res, body, state };
    if (op === "claim") {
      state.claims.push(body);
      if (hooks.claim?.(ctx)) return;
      const leases = state.pending.splice(0);
      if (leases.length) state.claimToken = body.claim_token;
      else await new Promise(resolve => setTimeout(resolve, 20));
      reply({ protocol: "purefect-ai-execution/1", leases });
      return;
    }
    const holds =
      body.job_id === "101" && body.generation === 1 && body.claim_token === state.claimToken;
    if (op === "sync") {
      state.syncs.push(body);
      if (hooks.sync?.(ctx)) return;
      if (!holds) return fault("ai_lease_lost");
      if (body.events?.length) {
        if (body.offset > state.events.length)
          return fault("ai_event_offset_gap", { expected: state.events.length });
        const skip = Math.min(body.events.length, state.events.length - body.offset);
        state.events.push(...body.events.slice(skip));
        hooks.accepted?.(ctx);
      }
      for (const request of body.action_requests ?? [])
        if (!state.actions.some(a => a.action_id === request.action_id))
          state.actions.push(request);
      let receipts = (body.awaiting_actions ?? []).filter(id => state.receipts.has(id));
      if (!receipts.length && body.awaiting_actions?.length && body.wait_ms > 0) {
        const end = Date.now() + body.wait_ms;
        while (Date.now() < end && !receipts.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
          receipts = body.awaiting_actions.filter(id => state.receipts.has(id));
        }
      }
      if (state.withdrawn) {
        // Same shape as the Engine's subject-withdrawn response (contract/examples): no agent_token.
        reply({
          ...state.withdrawn,
          lease_until: Date.now() + 30000,
          event_offset: state.events.length
        });
        return;
      }
      state.lastToken = `agent-token-renewed-${++state.tokens}-` + "r".repeat(32);
      reply({
        protocol: "purefect-ai-execution/1",
        lease_until: Date.now() + (state.leaseMs ?? 30000),
        cancel: state.cancel,
        event_offset: state.events.length,
        // Platform serialization omits empty lists.
        ...(receipts.length
          ? { action_receipts: receipts.map(id => ({ action_id: id, ...state.receipts.get(id) })) }
          : {}),
        agent_token: { value: state.lastToken, expires_at: Date.now() + 60000 }
      });
      return;
    }
    if (op === "output") {
      state.outputs.push(body);
      if (hooks.output?.(ctx)) return;
      if (!holds) return fault("ai_lease_lost");
      if (body.rejected) return reply({ protocol: "purefect-ai-execution/1" });
      reply({
        protocol: "purefect-ai-execution/1",
        file_id: `file-${state.outputs.length}`,
        name: body.name,
        content_type: body.content_type,
        size: Buffer.from(body.content_base64, "base64").length
      });
      return;
    }
    if (op === "propose") {
      state.proposes.push(body);
      if (hooks.propose?.(ctx)) return;
      if (!holds) return fault("ai_lease_lost");
      reply({ protocol: "purefect-ai-execution/1", result: "dispatched", task_id: "901" });
      return;
    }
    if (op === "complete") {
      state.completes.push(body);
      if (!holds) return fault("ai_complete_rejected");
      const digest = JSON.stringify(body.outcome);
      let result = "ACCEPTED";
      if (state.accepted !== undefined) {
        if (state.accepted !== digest) return fault("ai_complete_rejected");
        result = "ALREADY_ACCEPTED";
      }
      state.accepted = digest;
      if (hooks.complete?.(ctx)) return;
      reply({ protocol: "purefect-ai-execution/1", result });
      return;
    }
    send(404, { code: 404, success: false });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const control = new PapiControlPlane({
    origin: `http://127.0.0.1:${server.address().port}`,
    allowLoopbackHttp: true,
    site: "ctl",
    tenant: "tenant-a",
    principalId: "svc-1",
    secret: SERVICE_SECRET
  });
  return { state, control };
}

/** RunAdapter test double driven by a script. */
function fakeDriver(script, journal = []) {
  const driver = new EventEmitter();
  let sequence = 0;
  let terminal = false;
  let cancelled;
  const cancelledPromise = new Promise(resolve => (cancelled = resolve));
  driver.capabilities = { schemaVersion: 1, modelWire: "responses" };
  driver.stopEvidence = undefined;
  driver.cancels = 0;
  driver.emitEvent = (type, data = {}) => {
    if (terminal) return;
    if (type.startsWith("run.")) terminal = true;
    driver.emit("event", {
      schemaVersion: 1,
      runId: driver.input.runId,
      sequence: ++sequence,
      type,
      data
    });
  };
  driver.waitCancel = () => cancelledPromise;
  driver.execute = async input => {
    journal.push("execute");
    driver.input = input;
    try {
      // Like the Codex adapter: prepare, then wait for admission before the model turn.
      await input.beforeTurn?.();
      journal.push("turn");
      await script(driver, input);
    } finally {
      driver.stopEvidence = { state: "exited", code: 0, signal: null };
    }
  };
  driver.cancel = async () => {
    driver.cancels++;
    driver.emitEvent("run.cancelled");
    cancelled();
  };
  driver.dispose = async () => {
    driver.stopEvidence ??= { state: "exited", code: 0, signal: null };
  };
  return driver;
}

/** `closeState` is one state or the states of successive close() calls (the last one repeats). */
function fakeLauncher(createDriver, journal = [], closeState = "stopped") {
  const launcher = {
    capabilities: { isolation: "container" },
    requests: [],
    renewals: [],
    closed: 0,
    drivers: []
  };
  launcher.open = async request => {
    journal.push("open");
    launcher.requests.push(request);
    const driver = createDriver(request);
    launcher.drivers.push(driver);
    return {
      driver,
      ...(launcher.outputs
        ? {
            outputs: async () => {
              journal.push("outputs");
              return launcher.outputs(request);
            }
          }
        : {}),
      renew: async leaseUntil => {
        launcher.renewals.push(leaseUntil);
      },
      close: async () => {
        const attempt = launcher.closed++;
        await launcher.beforeClose?.(attempt);
        await driver.dispose();
        return Array.isArray(closeState)
          ? closeState[Math.min(attempt, closeState.length - 1)]
          : closeState;
      }
    };
  };
  return launcher;
}

function lane(control, launcher, registry, logs, options = {}) {
  return new ExecutionLane(control, launcher, registry, {
    runtimeId: "rt-1",
    lanes: ["interactive"],
    enabledTools: ["metadata.get_raw"],
    claimWaitMs: 0,
    syncIntervalMs: 20,
    actionWaitMs: 300,
    heartbeatMs: 25,
    stopRetryMs: 10,
    log: (code, fields) => logs.push({ code, ...fields }),
    ...options
  });
}

function assertNoSecrets(...values) {
  for (const value of values) {
    const text =
      typeof value === "string" ? value : JSON.stringify(value) + inspect(value, { depth: 8 });
    for (const secret of SECRETS) assert.ok(!text.includes(secret), "secret leaked");
  }
}

test("happy path: claim, started before execution, contiguous deltas, complete with answer and usage", async t => {
  const { state, control } = await fakeEngine(t);
  state.pending.push(lease());
  const registry = new RunCredentialRegistry();
  const upstreamCalls = [];
  const models = new LocalModelAuthority(
    registry,
    { functions: {}, maxOutputTokens: 1000 },
    {
      messages: () => assert.fail("no Messages upstream"),
      responses: () => ({
        async invoke(request, model, secret) {
          upstreamCalls.push({ model, secret, alias: request.model });
          return { events: [], usage: { inputTokens: 11, outputTokens: 7 } };
        }
      })
    }
  );
  const gateway = new ModelGateway(models, models, models.provider);
  const journal = state.log;
  const launcher = fakeLauncher(
    request =>
      fakeDriver(async (driver, input) => {
        const binding = await models.lookup(request.modelCapability);
        await gateway.respond(
          request.modelCapability,
          binding.runtime,
          "call-1",
          { model: request.modelAlias, input: "hi", stream: true },
          binding
        );
        driver.emitEvent("message.delta", { delta: "Hel" });
        await until(() => state.events.length >= 1);
        driver.emitEvent("message.delta", { delta: "lo " });
        driver.emitEvent("message.delta", { delta: "world" });
        driver.emitEvent("run.completed");
        assert.equal(input.promptFormat, "conversation-context-v1");
      }, journal),
    journal
  );
  const logs = [];
  const worker = lane(control, launcher, registry, logs, { admit: c => models.admit(c) });
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.completes.length === 1);
  worker.drain();
  await running;

  assert.deepEqual([...state.headers], [`svc-1:${SERVICE_SECRET}`]);
  const claim = state.claims[0];
  assert.equal(claim.runtime_id, "rt-1");
  assert.deepEqual(claim.lanes, ["interactive"]);
  assert.match(claim.claim_token, /^[A-Za-z0-9_-]{43}$/);
  // started is reported once input is delivered; the Driver may prepare meanwhile, but its
  // model turn waits for the acknowledgement.
  assert.equal(state.syncs[0].started, true);
  assert.ok(journal.indexOf("open") < journal.indexOf("sync"));
  assert.ok(journal.indexOf("open") < journal.indexOf("execute"));
  assert.ok(journal.indexOf("sync") < journal.indexOf("turn"));
  assert.equal(state.faults.length, 0);
  assert.equal(state.events.map(e => e.data.delta).join(""), "Hello world");
  assert.ok(state.events.every(e => e.type === "assistant.message.delta"));
  const complete = state.completes[0];
  assert.deepEqual(
    { job_id: complete.job_id, generation: complete.generation, claim_token: complete.claim_token },
    { job_id: "101", generation: 1, claim_token: claim.claim_token }
  );
  assert.deepEqual(complete.outcome, {
    status: "SUCCEEDED",
    answer: "Hello world",
    usage: { input_tokens: 11, output_tokens: 7 }
  });
  // The CLI uses the deployment alias; the gateway maps it to the Run's upstream model.
  assert.equal(launcher.requests[0].modelAlias, "sandlane");
  assert.equal(launcher.requests[0].toolServer, "tools");
  assert.deepEqual(upstreamCalls, [{ model: "gpt-test", secret: MODEL_KEY, alias: "sandlane" }]);
  // Only capabilities enter the sandbox.
  const request = launcher.requests[0];
  assertNoSecrets(request);
  assert.match(request.modelCapability, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(request.modelCapability, request.toolCapability);
  assert.ok(launcher.renewals.length >= 1);
  // No conversation files: no inputs and no file mode for the Driver.
  assert.equal(request.inputs, undefined);
  assert.equal(launcher.drivers[0].input.fileTools, undefined);
  assert.equal(launcher.closed, 1);
  assert.equal(registry.size, 0);
  assert.equal(await models.lookup(request.modelCapability), null);
  assertNoSecrets(logs);
});

test("the first event and first text sync without the throttle gap; TIMING shares the claim clock", async t => {
  const sent = [];
  const { state, control } = await fakeEngine(t, {
    sync: ({ body }) => {
      if (body.events?.length) sent.push({ at: performance.now(), events: body.events });
    }
  });
  state.pending.push(lease());
  const registry = new RunCredentialRegistry();
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("item.started", { item: { type: "tool", tool: "metadata.get_raw" } });
      await until(() => state.events.length >= 1);
      driver.emitEvent("message.delta", { delta: "A" });
      await until(() => state.events.length >= 2);
      driver.emitEvent("message.delta", { delta: "B" });
      await until(() => state.events.length >= 3);
      driver.emitEvent("run.completed");
    })
  );
  const logs = [];
  const worker = lane(control, launcher, registry, logs);
  const running = worker.run(new AbortController().signal);
  await until(() => state.completes.length === 1);
  worker.drain();
  await running;

  assert.deepEqual(
    sent.map(s => s.events.map(e => e.data.delta ?? e.type)),
    [["runtime.item.started"], ["A"], ["B"]]
  );
  // The first text follows the previous sync at once; later text keeps the 100ms throttle.
  assert.ok(sent[1].at - sent[0].at < 80, `first text waited ${sent[1].at - sent[0].at}ms`);
  assert.ok(sent[2].at - sent[1].at >= 90, `later text skipped the throttle`);

  const timing = logs.filter(l => l.code === "TIMING");
  assert.deepEqual(
    timing.map(l => l.phase),
    ["claimed", "sandbox-ready", "started-acked", "first-delta-synced"]
  );
  assert.ok(timing.every(l => l.run === "201" && Number.isInteger(l.elapsedMs)));
  assert.equal(timing[0].elapsedMs, 0);
  assert.ok(Number.isInteger(timing[0].claimMs) && timing[0].claimMs >= 0);
  for (let i = 1; i < timing.length; i++) assert.ok(timing[i].elapsedMs >= timing[i - 1].elapsedMs);
  // Driver phases are measured from the same origin.
  const origin = launcher.drivers[0].input.timingOrigin;
  assert.ok(typeof origin === "number" && origin <= performance.now());
});

test("status observer: lane states, the Run's phases and its settlement; no identities or text", async t => {
  const { state, control } = await fakeEngine(t);
  state.pending.push(lease());
  const registry = new RunCredentialRegistry();
  const events = [];
  const recorder = new StatusRecorder({ queues: ["interactive"], concurrency: 1, runIds: "plain" });
  const observe = recorder.lane(0);
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "secret answer text" });
      await until(() => state.events.length >= 1);
      driver.emitEvent("run.completed");
    })
  );
  const worker = lane(control, launcher, registry, [], {
    observe: event => {
      events.push(event);
      observe(event);
    }
  });
  const running = worker.run(new AbortController().signal);
  await until(() => state.completes.length === 1);
  await until(() => events.some(e => e.type === "run.ended"));
  worker.drain();
  await running;

  const lanes = events.filter(e => e.type === "lane").map(e => e.state);
  assert.equal(lanes[0], "claiming");
  assert.equal(lanes.at(-1), "stopped");
  const run = events.filter(e => e.type.startsWith("run."));
  assert.deepEqual(run[0], { type: "run.started", run: "201", harness: "codex" });
  assert.deepEqual(
    run.filter(e => e.type === "run.phase").map(e => e.phase),
    ["claimed", "sandbox-ready", "started-acked", "first-delta-synced"]
  );
  assert.deepEqual(run.at(-1), {
    type: "run.ended",
    run: "201",
    status: "SUCCEEDED",
    settlement: "settled"
  });
  const recent = recorder.snapshot().runs.recent[0];
  assert.equal(recent.id, "201");
  assert.equal(recent.status, "SUCCEEDED");
  assert.equal(recent.lane, 0);
  assert.ok(recent.phases["sandbox-ready"] >= 0);
  assert.equal(recorder.snapshot().lanes.items[0].state, "stopped");
  // Events carry identifiers, states and codes only: no tenant, user, prompt, answer or secret.
  const keys = new Set(events.flatMap(e => Object.keys(e)));
  assert.deepEqual([...keys].sort(), [
    "elapsedMs",
    "harness",
    "phase",
    "run",
    "settlement",
    "state",
    "status",
    "type"
  ]);
  const text = JSON.stringify(events);
  for (const value of ["acme", "site-a", "Hello", "secret answer text"])
    assert.ok(!text.includes(value), value);
  assertNoSecrets(events, recorder.snapshot());
});

test("status observer: a lost lease ends as lost, never settled; a throwing observer is harmless", async t => {
  const { state, control } = await fakeEngine(t, {
    sync: ({ state, fault }) => {
      if (state.syncs.length >= 3) {
        fault("ai_lease_lost");
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "working" });
      await driver.waitCancel();
    })
  );
  const events = [];
  await lane(control, launcher, new RunCredentialRegistry(), [], {
    observe: event => {
      events.push(event);
      throw new Error("observer failure");
    }
  }).execute(lease(), state.claimToken, new AbortController().signal);
  assert.equal(state.completes.length, 0);
  const ended = events.find(e => e.type === "run.ended");
  assert.equal(ended.settlement, "lost");
  assert.equal(ended.status, "FAILED");
  assert.equal(ended.error, "lease_lost");
});

test("event offset gap: resend from the Engine's expected offset", async t => {
  let faulted = false;
  const { state, control } = await fakeEngine(t, {
    sync: ({ body, state, fault }) => {
      // Simulate an Engine that lost an acknowledged prefix: it now expects offset 0.
      if (!faulted && body.events?.length && body.offset > 0) {
        faulted = true;
        state.events.length = 0;
        fault("ai_event_offset_gap", { expected: 0 });
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "one " });
      await until(() => state.events.length === 1);
      driver.emitEvent("message.delta", { delta: "two" });
      await until(() => faulted);
      driver.emitEvent("run.completed");
    })
  );
  const logs = [];
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(state.faults, ["ai_event_offset_gap"]);
  assert.equal(state.events.map(e => e.data.delta).join(""), "one two");
  assert.equal(state.completes[0].outcome.answer, "one two");
  assert.ok(logs.some(l => l.code === "EVENT_OFFSET_GAP" && l.expected === 0));
});

test("cancel from sync stops the Driver and completes as CANCELLED", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "partial" });
      await until(() => state.events.length === 1);
      state.cancel = true;
      await driver.waitCancel();
    })
  );
  await lane(control, launcher, registry, []).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(launcher.drivers[0].cancels >= 1, true);
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
  assert.equal(state.completes[0].outcome.answer, "partial");
  assert.equal(launcher.closed, 1);
  assert.equal(registry.size, 0);
});

test("subject withdrawn: a cancel without agent_token drops the token and completes as CANCELLED", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const example = JSON.parse(
    await readFile(
      new URL("../contract/examples/sync-response-subject-withdrawn.json", import.meta.url),
      "utf8"
    )
  );
  const registry = new RunCredentialRegistry();
  const tokens = [];
  const launcher = fakeLauncher(request =>
    fakeDriver(async driver => {
      const credential = registry.byModelCapability(request.modelCapability);
      driver.emitEvent("message.delta", { delta: "partial" });
      await until(() => state.events.length === 1);
      tokens.push(credential.agentToken()?.value);
      state.withdrawn = example;
      await driver.waitCancel();
      tokens.push(credential.agentToken());
    })
  );
  await lane(control, launcher, registry, []).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.ok(tokens[0], "a renewed token was held before the subject lost access");
  assert.equal(tokens[1], undefined, "the token is dropped as soon as the withdrawn sync lands");
  assert.equal(launcher.drivers[0].cancels >= 1, true);
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
  assert.equal(registry.size, 0);
});

test("the lane's reasoning effort from the lease reaches the Driver", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const seen = [];
  const launcher = fakeLauncher(() =>
    fakeDriver(async (driver, input) => {
      seen.push(input.reasoningEffort);
      driver.emitEvent("run.completed");
    })
  );
  const worker = lane(control, launcher, registry, []);
  const fast = lease();
  fast.credentials.model_service.reasoning_effort = "low";
  await worker.execute(fast, state.claimToken, new AbortController().signal);
  await worker.execute(lease(), state.claimToken, new AbortController().signal);
  assert.deepEqual(seen, ["low", undefined]);
  assert.equal(state.completes.length, 2);
});

test("the lease's Harness selects the sandbox; Drivers get no tool bridge", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const seen = [];
  const launcher = fakeLauncher(request =>
    Object.assign(
      fakeDriver(async (driver, input) => {
        const credential = registry.byModelCapability(request.modelCapability);
        seen.push({
          harness: request.harness,
          grant: [credential.grant.harness, credential.grant.modelWire],
          clientAction: "clientAction" in input,
          workspaceAction: "workspaceAction" in input
        });
        driver.emitEvent("message.delta", { delta: "ok" });
        driver.emitEvent("run.completed");
      }),
      {
        capabilities: { schemaVersion: 1, modelWire: "anthropic-messages" }
      }
    )
  );
  const claude = lease({ run: { harness: "claude-code" } });
  claude.credentials.model_service.wire_api = "anthropic-messages";
  await lane(control, launcher, registry, []).execute(
    claude,
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(seen, [
    {
      harness: "claude-code",
      grant: ["claude-code", "anthropic-messages"],
      clientAction: false,
      workspaceAction: false
    }
  ]);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  assert.equal(registry.size, 0);
});

test("a Harness this Worker cannot run settles as a definite harness_unavailable failure", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  // No image on the Broker (the provider refuses), then a Driver of another wire.
  const unavailable = fakeLauncher(() => {
    throw new Error("HARNESS_UNAVAILABLE");
  });
  const claude = lease({ run: { harness: "claude-code" } });
  claude.credentials.model_service.wire_api = "anthropic-messages";
  await lane(control, unavailable, registry, []).execute(
    claude,
    state.claimToken,
    new AbortController().signal
  );
  const mismatched = fakeLauncher(() =>
    fakeDriver(async () => assert.fail("a Driver of another wire must not run"))
  );
  await lane(control, mismatched, registry, []).execute(
    claude,
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(
    state.completes.map(complete => [complete.outcome.status, complete.outcome.error?.code]),
    [
      ["FAILED", "harness_unavailable"],
      ["FAILED", "harness_unavailable"]
    ]
  );
  assert.equal(mismatched.closed, 1, "the opened sandbox is stopped");
  assert.equal(registry.size, 0);
});

test("unconfirmed sandbox stop withholds settlement and revokes gateway access at once", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const capabilities = [];
  const launcher = fakeLauncher(
    request => {
      capabilities.push(request.modelCapability);
      return fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "done" });
        driver.emitEvent("run.completed");
      });
    },
    [],
    "unknown"
  );
  const logs = [];
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(launcher.closed, 4, "stop is retried with backoff up to the attempt limit");
  assert.equal(logs.filter(l => l.code === "SANDBOX_STOP_RETRY").length, 3);
  assert.equal(state.completes.length, 0, "a terminal result would release the next Run early");
  assert.equal(registry.size, 0);
  assert.equal(registry.byModelCapability(capabilities[0]), undefined);
  assert.ok(logs.some(l => l.code === "SETTLEMENT_WITHHELD"));
});

test("ai_lease_lost stops execution and never completes", async t => {
  const { state, control } = await fakeEngine(t, {
    sync: ({ state, fault }) => {
      if (state.syncs.length >= 3) {
        fault("ai_lease_lost");
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const capabilities = [];
  const launcher = fakeLauncher(request => {
    capabilities.push(request.toolCapability);
    return fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "working" });
      await driver.waitCancel();
    });
  });
  const logs = [];
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(state.completes.length, 0);
  assert.ok(launcher.drivers[0].cancels >= 1);
  assert.equal(launcher.closed, 1);
  assert.equal(registry.size, 0);
  assert.equal(registry.byToolCapability(capabilities[0]), undefined);
  assert.ok(logs.some(l => l.code === "LEASE_LOST"));
  assertNoSecrets(logs);
});

test("tool-call activity reaches the Engine as sanitized runtime.item events, in order with text", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  let observer;
  let turnAfterStarted;
  const emit = value => observer.stdout(Buffer.from(JSON.stringify(value) + "\n"));
  const item = status => ({
    type: "mcpToolCall",
    id: "call-1",
    server: "purefect",
    tool: "metadata_get_raw",
    status,
    arguments: {
      api_code: "pf.designer.meta.MetaManager::get_raw",
      params: { code: "secret-biz-code" }
    },
    result: { content: [{ type: "text", text: "business data" }] }
  });
  const launcher = fakeLauncher(
    () =>
      new CodexRunAdapter({
        workspace: "/workspace",
        transport: {
          async start(value) {
            observer = value;
          },
          async write(bytes) {
            const message = JSON.parse(bytes);
            if (message.method === "initialize") emit({ id: message.id, result: {} });
            if (message.method === "thread/start")
              emit({ id: message.id, result: { thread: { id: "thread-1" } } });
            if (message.method === "turn/start") {
              // The model turn starts only after the Engine acknowledged "started".
              turnAfterStarted = state.syncs.some(s => s.started);
              emit({ id: message.id, result: { turn: { id: "turn-1" } } });
              emit({ method: "item/agentMessage/delta", params: { delta: "Checking. " } });
              emit({ method: "item/started", params: { item: item("inProgress") } });
              emit({ method: "item/started", params: { item: { type: "reasoning", id: "r1" } } });
              emit({ method: "item/completed", params: { item: item("completed") } });
              emit({ method: "item/agentMessage/delta", params: { delta: "Done." } });
              emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
            }
          },
          async stop() {
            return { state: "exited", code: 0, signal: null };
          }
        }
      })
  );
  await lane(control, launcher, new RunCredentialRegistry(), []).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(
    state.events.map(e => e.type),
    [
      "assistant.message.delta",
      "runtime.item.started",
      "runtime.item.completed",
      "assistant.message.delta"
    ]
  );
  assert.deepEqual(state.events[2].data.item, {
    type: "mcpToolCall",
    id: "call-1",
    server: "purefect",
    tool: "metadata_get_raw",
    status: "completed",
    arguments: { api_code: "pf.designer.meta.MetaManager::get_raw" }
  });
  assert.ok(!JSON.stringify(state.events).includes("business data"));
  assert.ok(!JSON.stringify(state.events).includes("secret-biz-code"));
  assert.equal(state.completes[0].outcome.answer, "Checking. Done.");
  assert.equal(turnAfterStarted, true);
});

test("web access: frozen policy reaches the grant and the instructions; Codex web searches become sanitized items", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  let observer;
  const emit = value => observer.stdout(Buffer.from(JSON.stringify(value) + "\n"));
  const threads = [];
  const launcher = fakeLauncher(
    () =>
      new CodexRunAdapter({
        workspace: "/workspace",
        transport: {
          async start(value) {
            observer = value;
          },
          async write(bytes) {
            const message = JSON.parse(bytes);
            if (message.method === "initialize") emit({ id: message.id, result: {} });
            if (message.method === "thread/start") {
              threads.push(message.params);
              emit({ id: message.id, result: { thread: { id: "thread-1" } } });
            }
            if (message.method === "turn/start") {
              emit({ id: message.id, result: { turn: { id: "turn-1" } } });
              // app-server item shapes measured with Codex 0.154.0.
              const search = {
                type: "webSearch",
                id: "ws_1",
                query: "",
                action: { type: "other" },
                results: null
              };
              emit({ method: "item/started", params: { item: search } });
              emit({
                method: "item/completed",
                params: {
                  item: {
                    ...search,
                    query: "sandlane release",
                    action: { type: "search", query: "sandlane release", queries: null },
                    results: ["page body"]
                  }
                }
              });
              const page = {
                type: "webSearch",
                id: "ws_2",
                query: "",
                action: { type: "openPage", url: "https://docs.example.com/a?token=x" }
              };
              emit({ method: "item/completed", params: { item: page } });
              emit({ method: "item/agentMessage/delta", params: { delta: "Done." } });
              emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
            }
          },
          async stop() {
            return { state: "exited", code: 0, signal: null };
          }
        }
      })
  );
  const grants = [];
  await lane(control, launcher, new RunCredentialRegistry(), [], {
    context: new FrozenInputContext("Business instructions."),
    admit: credential => grants.push(credential.grant)
  }).execute(
    lease({ run: { web_access: { open: false, allowed_domains: ["example.com"] } } }),
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(grants[0].webAccess, { mode: "allowlist", domains: ["example.com"] });
  assert.match(threads[0].baseInstructions, /^Business instructions\.\nWeb search is available/);
  assert.match(threads[0].baseInstructions, /example\.com/);
  assert.deepEqual(
    state.events.filter(e => e.type.startsWith("runtime.item")).map(e => e.data.item),
    [
      { type: "webSearch", id: "ws_1", title: "联网搜索", status: "inProgress" },
      {
        type: "webSearch",
        id: "ws_1",
        title: "联网搜索",
        status: "completed",
        query: "sandlane release"
      },
      {
        type: "webSearch",
        id: "ws_2",
        title: "联网搜索",
        status: "completed",
        domain: "docs.example.com"
      }
    ]
  );
  assert.ok(!JSON.stringify(state.events).includes("page body"));
  assert.ok(!JSON.stringify(state.events).includes("token=x"));
});

test("web access: a lease without a grant runs without web access or web instructions", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const grants = [];
  const turns = [];
  const context = new FrozenInputContext("Business instructions.");
  await lane(
    control,
    fakeLauncher(() =>
      fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "ok" });
        driver.emitEvent("run.completed");
      })
    ),
    new RunCredentialRegistry(),
    [],
    {
      context: {
        turn: async (request, signal) => {
          const turn = await context.turn(request, signal);
          turns.push(turn);
          return turn;
        }
      },
      admit: credential => grants.push(credential.grant)
    }
  ).execute(lease(), state.claimToken, new AbortController().signal);
  assert.deepEqual(grants[0].webAccess, { mode: "off", domains: [] });
  assert.equal(turns[0].instructions, "Business instructions.");
});

const PAGE_CONTEXT = {
  workspace_action_protocol: "purefect-workspace-interaction/1",
  surface: "console",
  execution_mode: "manual",
  operations: [...ALL_INTERACTION_OPS],
  open_pages: [{ page: "sales.OrderList" }],
  interaction: 1
};

/** A Run whose Driver script gets the Run's MCP binding (as the tool gateway resolves it). */
async function pageRun(t, uiContext, script, { run: runFields, ...options } = {}) {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(
    registry,
    { serverId: "purefect", targetRef: "local", targetVersion: 1 },
    TOOL_CATALOG
  );
  const launcher = fakeLauncher(request =>
    fakeDriver(async driver => {
      const binding = await tools.lookup(request.toolCapability);
      await script({ driver, binding, request, state });
      driver.emitEvent("message.delta", { delta: "Done" });
      driver.emitEvent("run.completed");
    })
  );
  const raw = lease({
    run: { input: { prompt: "Which page?", history: [], ui_context: uiContext }, ...runFields }
  });
  await lane(control, launcher, registry, [], {
    enabledTools: ["metadata.get_raw", "workspace_action"],
    ...options
  }).execute(raw, state.claimToken, new AbortController().signal);
  return { state, launcher, registry, tools };
}

test("page action over MCP: offered to this Run, relayed through sync, receipt back as the tool result", async t => {
  let capability;
  const { state, launcher, tools } = await pageRun(
    t,
    PAGE_CONTEXT,
    async ({ binding, request, state }) => {
      capability = request.toolCapability;
      // The CLI is told about the tool (enabled_tools / --allowedTools); the grant keeps gateway tools.
      assert.deepEqual(request.enabledTools, ["metadata.get_raw", "workspace_action"]);
      assert.deepEqual(binding.enabledTools, ["metadata.get_raw"]);
      const action = binding.clientAction;
      assert.equal(action.name, "workspace_action");
      assert.deepEqual(action.inputSchema.properties.op.enum, [...ALL_INTERACTION_OPS]);
      const pending = action.call(
        { op: "describe", target: "target-A" },
        new AbortController().signal
      );
      await until(() => state.actions.length === 1);
      const sent = state.actions[0];
      assert.match(sent.action_id, /^act_/);
      assert.equal(sent.op, "describe");
      assert.deepEqual(sent.arguments, { op: "describe", target: "target-A" });
      await until(() =>
        state.syncs.some(s => s.awaiting_actions?.includes(sent.action_id) && s.wait_ms > 0)
      );
      // Browser settles the action; the receipt has no actionId of its own.
      state.receipts.set(sent.action_id, {
        status: "SETTLED",
        receipt: { status: "succeeded", result: { page: "orders" } }
      });
      assert.deepEqual(await pending, {
        status: "succeeded",
        result: { page: "orders" },
        actionId: sent.action_id
      });
    }
  );
  assert.equal(launcher.requests.length, 1);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  // The Run is over: its capability resolves to nothing, so the action is gone with it.
  assert.equal(await tools.lookup(capability), null);
});

test("page action: the turn's declared operations shape the tool; arguments are checked before sync", async t => {
  const { state } = await pageRun(
    t,
    { ...PAGE_CONTEXT, operations: ["focus", "describe"] },
    async ({ binding }) => {
      const action = binding.clientAction;
      assert.deepEqual(action.inputSchema.properties.op.enum, ["describe", "focus"]);
      const signal = new AbortController().signal;
      const refused = await action.call({ op: "patch", target: "t" }, signal);
      assert.equal(refused.status, "failed");
      assert.equal(refused.error.code, "invalid_argument");
      assert.match(refused.error.message, /op must be one of describe\|focus/);
      assert.match(refused.actionId, /^act_/);
      const malformed = await action.call({ op: "focus" }, signal);
      assert.match(malformed.error.message, /target/);
    }
  );
  assert.equal(state.actions.length, 0);
});

test("page action is not offered without interaction, on mobile, or when not enabled", async t => {
  for (const [context, options] of [
    [{ ...PAGE_CONTEXT, interaction: undefined }, {}],
    [{ ...PAGE_CONTEXT, surface: "mobile" }, {}],
    [PAGE_CONTEXT, { enabledTools: ["metadata.get_raw"] }]
  ]) {
    const { state } = await pageRun(
      t,
      context,
      async ({ binding, request }) => {
        assert.equal(binding.clientAction, undefined);
        assert.deepEqual(request.enabledTools, ["metadata.get_raw"]);
      },
      options
    );
    assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  }
  // At least one gateway tool must stay: the page tool alone is not a valid configuration.
  const { control } = await fakeEngine(t);
  assert.throws(
    () =>
      lane(
        control,
        fakeLauncher(() => fakeDriver(async () => {})),
        new RunCredentialRegistry(),
        [],
        {
          enabledTools: ["workspace_action"]
        }
      ),
    /INVALID_LANE_CONFIGURATION/
  );
});

test("the control plane narrows a Run's tools (member settings) but never widens them", async t => {
  for (const [tools, expected, page] of [
    [["workspace_action", "web_search"], ["workspace_action"], true],
    [["metadata.get_raw", "unknown_tool"], ["metadata.get_raw"], false]
  ]) {
    const { state } = await pageRun(
      t,
      PAGE_CONTEXT,
      async ({ binding, request }) => {
        assert.deepEqual(request.enabledTools, expected);
        assert.equal(binding.clientAction !== undefined, page);
      },
      { run: { tools } }
    );
    assert.equal(
      state.completes[0].outcome.status,
      "SUCCEEDED",
      JSON.stringify(state.completes[0].outcome)
    );
  }
});

test("page actions run one at a time and time out with a timeout receipt", async t => {
  const { state } = await pageRun(
    t,
    PAGE_CONTEXT,
    async ({ binding, state }) => {
      const signal = new AbortController().signal;
      const first = binding.clientAction.call({ op: "describe", target: "a" }, signal);
      const second = binding.clientAction.call({ op: "describe", target: "b" }, signal);
      await until(() => state.actions.length === 1);
      // The second waits for the first receipt before it is sent.
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(state.actions.length, 1);
      state.receipts.set(state.actions[0].action_id, {
        status: "SETTLED",
        receipt: { status: "succeeded" }
      });
      assert.equal((await first).status, "succeeded");
      await until(() => state.actions.length === 2);
      assert.equal(state.actions[1].arguments.target, "b");
      // No receipt for the second: the lane answers with a bounded timeout receipt.
      const late = await second;
      assert.equal(late.error.code, "timeout");
      assert.equal(late.actionId.startsWith("act_"), true);
    },
    { clientActionTimeoutMs: 400 }
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("a page action pending at cancellation resolves unavailable instead of hanging", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(
    registry,
    { serverId: "purefect", targetRef: "local", targetVersion: 1 },
    TOOL_CATALOG
  );
  let receipt;
  const launcher = fakeLauncher(request =>
    fakeDriver(async driver => {
      const binding = await tools.lookup(request.toolCapability);
      const pending = binding.clientAction.call(
        { op: "describe", target: "a" },
        new AbortController().signal
      );
      await until(() => state.actions.length === 1);
      state.cancel = true;
      receipt = await pending;
      await driver.waitCancel();
    })
  );
  const raw = lease({
    run: { input: { prompt: "Which page?", history: [], ui_context: PAGE_CONTEXT } }
  });
  await lane(control, launcher, registry, [], {
    enabledTools: ["metadata.get_raw", "workspace_action"]
  }).execute(raw, state.claimToken, new AbortController().signal);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "unavailable");
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
});

/** A Run with a confirm policy; the script gets the Run's approval bridge as the tool gateway
 * resolves it. */
async function confirmRun(t, { codes, uiContext, source }, script, options = {}) {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(
    registry,
    { serverId: "purefect", targetRef: "local", targetVersion: 1 },
    TOOL_CATALOG
  );
  const turns = [];
  const logs = [];
  const launcher = fakeLauncher(request =>
    fakeDriver(async driver => {
      const binding = await tools.lookup(request.toolCapability);
      const bridge = tools.confirmation({
        capability: request.toolCapability,
        runtime: binding.runtime
      });
      await script({ binding, bridge, state });
      driver.emitEvent("message.delta", { delta: "Done" });
      driver.emitEvent("run.completed");
    })
  );
  const raw = lease({
    run: {
      input: {
        prompt: "Delete order 1",
        history: [],
        ...(uiContext ? { ui_context: uiContext } : {})
      },
      ...(codes !== undefined ? { confirm_api_codes: codes } : {}),
      ...(source ? { source } : {})
    }
  });
  await lane(control, launcher, registry, logs, {
    context: {
      turn: async request => (turns.push(request), new FrozenInputContext().turn(request))
    },
    ...options
  }).execute(raw, state.claimToken, new AbortController().signal);
  return { state, turns, logs };
}

const ASK = {
  kind: "tool_call",
  tool: "purefect_call",
  title: "sales.order::delete",
  summary: 'api_code: sales.order::delete\nparams: id="1"'
};

test("approval bridge: op=confirm goes through sync and the receipt decides", async t => {
  const { state, turns, logs } = await confirmRun(
    t,
    { codes: ["*::delete"], uiContext: PAGE_CONTEXT },
    async ({ binding, bridge, state }) => {
      // A call may wait for the user: the MCP request gets the client action deadline.
      assert.equal(binding.confirms, true);
      assert.deepEqual(bridge.operations, ["*::delete"]);
      const signal = new AbortController().signal;
      const answer = async (receipt, index) => {
        const pending = bridge.confirm(ASK, signal);
        await until(() => state.actions.length === index + 1);
        const sent = state.actions[index];
        assert.match(sent.action_id, /^act_/);
        assert.equal(sent.op, "confirm");
        assert.deepEqual(sent.arguments, ASK);
        if (receipt) state.receipts.set(sent.action_id, receipt);
        return pending;
      };
      const settled = receipt => ({ status: "SETTLED", receipt });
      assert.equal(
        await answer(settled({ status: "succeeded", result: { approved: true } }), 0),
        "approved"
      );
      assert.equal(
        await answer(settled({ status: "succeeded", result: { approved: false } }), 1),
        "rejected"
      );
      assert.equal(await answer({ status: "VOID" }, 2), "unavailable");
      // No answer within the client action timeout.
      assert.equal(await answer(undefined, 3), "timeout");
    },
    { clientActionTimeoutMs: 400 }
  );
  assert.deepEqual(turns[0].confirmOperations, ["*::delete"]);
  assert.deepEqual(
    logs.filter(entry => entry.code === "TOOL_CONFIRMATION").map(entry => entry.outcome),
    ["approved", "rejected", "unavailable", "timeout"]
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("approval bridge: mobile turns without the page tool (even disabled) can still be asked", async t => {
  const mobile = {
    workspace_action_protocol: PAGE_CONTEXT.workspace_action_protocol,
    surface: "mobile"
  };
  const { state } = await confirmRun(
    t,
    { codes: ["*"], uiContext: mobile },
    async ({ binding, bridge, state }) => {
      assert.equal(binding.clientAction, undefined);
      const pending = bridge.confirm(ASK, new AbortController().signal);
      await until(() => state.actions.length === 1);
      assert.equal(state.actions[0].op, "confirm");
      state.receipts.set(state.actions[0].action_id, {
        status: "SETTLED",
        receipt: { status: "failed", error: { code: "rejected" } }
      });
      assert.equal(await pending, "rejected");
    },
    { enabledTools: ["metadata.get_raw"] }
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("approval bridge: no workbench context means unavailable at once, nothing relayed", async t => {
  const { state } = await confirmRun(t, { codes: ["*::delete"] }, async ({ bridge }) => {
    assert.equal(await bridge.confirm(ASK, new AbortController().signal), "unavailable");
  });
  assert.equal(state.actions.length, 0);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("approval bridge: absent or empty policy registers no bridge (no confirm is ever sent)", async t => {
  for (const codes of [undefined, []]) {
    const { state, turns } = await confirmRun(
      t,
      { codes, uiContext: PAGE_CONTEXT },
      async ({ binding, bridge }) => {
        assert.equal(bridge, undefined);
        assert.equal(binding.confirms, undefined);
      }
    );
    assert.deepEqual(turns[0].confirmOperations, []);
    assert.equal(state.actions.length, 0);
  }
});

test("complete retry after a dropped response is acknowledged as ALREADY_ACCEPTED", async t => {
  let dropped = false;
  const { state, control } = await fakeEngine(t, {
    complete: ({ res }) => {
      if (dropped) return false;
      dropped = true;
      res.destroy();
      return true;
    }
  });
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "answer" });
      driver.emitEvent("run.completed");
    })
  );
  const logs = [];
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(state.completes.length, 2);
  assert.deepEqual(state.completes[0].outcome, state.completes[1].outcome);
  assert.ok(logs.some(l => l.code === "COMPLETE_RETRY"));
  assert.ok(logs.some(l => l.code === "RUN_COMPLETED" && l.result === "ALREADY_ACCEPTED"));
  assertNoSecrets(logs);
});

test("agent token renewal from sync replaces the token used for tool calls", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(
    registry,
    { serverId: "tools", targetRef: "local", targetVersion: 1 },
    TOOL_CATALOG
  );
  const used = [];
  const gateway = new ToolGateway(
    tools,
    tools,
    new Map([
      [
        "tools",
        tools.bind({
          validate() {},
          async invoke(input, identity, accessToken) {
            used.push({ accessToken, tenantId: identity.tenantId, userId: identity.userId });
            return { ok: true };
          }
        })
      ]
    ])
  );
  let capability, runtime;
  const issued = [];
  const call = id =>
    gateway.invoke(capability, runtime, {
      callId: id,
      toolAlias: "metadata.get_raw",
      arguments: { type: "model", code: "x" }
    });
  const launcher = fakeLauncher(request => {
    capability = request.toolCapability;
    return fakeDriver(async driver => {
      runtime = (await tools.lookup(capability)).runtime;
      issued.push(state.lastToken);
      await call("c1");
      const before = state.syncs.length;
      await until(() => state.syncs.length >= before + 2);
      issued.push(state.lastToken);
      await call("c2");
      driver.emitEvent("run.completed");
    });
  });
  await lane(control, launcher, registry, []).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(used.length, 2);
  // The started sync already replaced the claim-time token; each later sync replaces it again.
  const serial = token => Number(/^agent-token-renewed-([0-9]+)-/.exec(token)?.[1] ?? -1);
  const [first, second] = used.map(u => serial(u.accessToken));
  // A response may still be in flight when the test samples the Engine's latest token.
  assert.ok(first >= serial(issued[0]) - 1 && first >= 1);
  assert.ok(second >= serial(issued[1]) - 1 && second > first);
  assert.ok(!used.some(u => u.accessToken === AGENT_TOKEN));
  assert.deepEqual(
    { tenantId: used[1].tenantId, userId: used[1].userId },
    { tenantId: "7", userId: "401" }
  );
  // Revoked after the Run: the capability no longer resolves and calls are refused.
  assert.equal(await tools.lookup(capability), null);
  await assert.rejects(call("c3"), /TOOL_CALL_REJECTED/);
  assert.equal(used.length, 2);
});

test("invalid lease content is settled as FAILED without starting a sandbox", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const raw = lease();
  raw.run.execution_profile = "inline";
  const launcher = fakeLauncher(() => fakeDriver(async () => {}));
  const logs = [];
  await lane(control, launcher, new RunCredentialRegistry(), logs).execute(
    raw,
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(launcher.requests.length, 0);
  assert.equal(state.completes[0].outcome.status, "FAILED");
  assert.equal(state.completes[0].outcome.error.code, "worker_invalid_lease");
  assertNoSecrets(logs, state.completes);
});

test("a long answer of token-sized deltas with tool activity settles SUCCEEDED", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const tool = (id, status) => ({
    item: { type: "mcpToolCall", id, server: "purefect", tool: "metadata_get_raw", status }
  });
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      // Well over the former 1024-observation limit: 3000 deltas plus 600 tool events.
      for (let i = 0; i < 300; i++) {
        driver.emitEvent("item.started", tool(`call-${i}`, "inProgress"));
        driver.emitEvent("item.completed", tool(`call-${i}`, "completed"));
        for (let j = 0; j < 10; j++) driver.emitEvent("message.delta", { delta: "ab" });
      }
      driver.emitEvent("run.completed");
    })
  );
  await lane(control, launcher, new RunCredentialRegistry(), []).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  const outcome = state.completes[0].outcome;
  assert.equal(outcome.status, "SUCCEEDED");
  assert.equal(outcome.answer, "ab".repeat(3000));
  const text = state.events.filter(e => e.type === "assistant.message.delta");
  assert.equal(text.map(e => e.data.delta).join(""), outcome.answer);
  assert.equal(state.events.filter(e => e.type === "runtime.item.completed").length, 300);
});

test("an answer over the result budget is truncated and still settles SUCCEEDED", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      for (let i = 0; i < 250; i++) driver.emitEvent("message.delta", { delta: "y".repeat(1000) });
      driver.emitEvent("run.completed");
    })
  );
  const logs = [];
  await lane(control, launcher, new RunCredentialRegistry(), logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  const outcome = state.completes[0].outcome;
  assert.equal(outcome.status, "SUCCEEDED");
  assert.equal(outcome.answer, "y".repeat(200_000));
  assert.ok(Buffer.byteLength(JSON.stringify(state.completes[0])) < 256 * 1024);
  assert.equal(state.events.map(e => e.data.delta).join(""), outcome.answer);
  assert.ok(logs.some(l => l.code === "ANSWER_TRUNCATED"));
});

test("a stop retry after an unconfirmed first attempt settles, with the Engine lease kept alive", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const launcher = fakeLauncher(
    () =>
      fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "done" });
        driver.emitEvent("run.completed");
      }),
    [],
    ["unknown", "stopped"]
  );
  let syncsBeforeStop, renewalsBeforeStop;
  launcher.beforeClose = async attempt => {
    if (attempt > 0) return;
    syncsBeforeStop = state.syncs.length;
    renewalsBeforeStop = launcher.renewals.length;
    // A slow Broker terminate: several heartbeat intervals.
    await new Promise(resolve => setTimeout(resolve, 200));
  };
  const logs = [];
  await lane(control, launcher, new RunCredentialRegistry(), logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.equal(launcher.closed, 2);
  assert.ok(logs.some(l => l.code === "SANDBOX_STOP_RETRY" && l.attempt === 1));
  assert.ok(!logs.some(l => l.code === "SANDBOX_STOP_UNCONFIRMED"));
  assert.ok(state.syncs.length > syncsBeforeStop, "heartbeats continue while stopping");
  assert.equal(launcher.renewals.length, renewalsBeforeStop, "the sandbox lease is not renewed");
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("complete retries protocol errors and non-terminal faults, stops on terminal faults", async t => {
  let attempts = 0;
  const { state, control } = await fakeEngine(t, {
    complete: ({ res, fault }) => {
      attempts++;
      if (attempts === 1) {
        fault("sys_internal_error");
        return true;
      }
      if (attempts === 2) {
        // A gateway error page in JSON form: no platform envelope.
        res.writeHead(502, { "content-type": "application/json" });
        res.end("{}");
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const logs = [];
  const run = lane(
    control,
    fakeLauncher(() =>
      fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "answer" });
        driver.emitEvent("run.completed");
      })
    ),
    new RunCredentialRegistry(),
    logs
  );
  await run.execute(lease(), state.claimToken, new AbortController().signal);
  assert.equal(state.completes.length, 3);
  assert.deepEqual(
    logs.filter(l => l.code === "COMPLETE_RETRY").map(l => l.error),
    ["sys_internal_error", "CONTROL_PLANE_PROTOCOL"]
  );
  assert.ok(logs.some(l => l.code === "RUN_COMPLETED" && l.result === "ALREADY_ACCEPTED"));

  for (const terminal of ["ai_invalid_input", "ai_lease_lost", "ai_complete_rejected"]) {
    const { state, control } = await fakeEngine(t, {
      complete: ({ fault }) => {
        fault(terminal);
        return true;
      }
    });
    state.claimToken = "c".repeat(43);
    const logs = [];
    const proof = { job_id: "101", generation: 1, claim_token: state.claimToken };
    const accepted = await lane(
      control,
      fakeLauncher(() => {}),
      new RunCredentialRegistry(),
      logs
    ).complete(proof, { status: "SUCCEEDED", answer: "x" }, Date.now() + 30_000);
    assert.equal(accepted, false);
    assert.equal(state.completes.length, 1, `${terminal} is not retried`);
    // Logged as the neutral code the Purefect control plane maps the Engine fault onto.
    assert.ok(
      logs.some(l => l.code === "COMPLETE_REJECTED" && l.error === terminal.replace(/^ai_/, ""))
    );
  }
});

test("lease loss revokes gateway access before the sandbox is stopped", async t => {
  const { state, control } = await fakeEngine(t, {
    sync: ({ body, fault }) => {
      if (body.events?.length) {
        fault("ai_lease_lost");
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const models = new LocalModelAuthority(registry, { functions: {}, maxOutputTokens: 1000 });
  let credential, capability;
  const atCancel = {};
  const launcher = fakeLauncher(request => {
    capability = request.modelCapability;
    const driver = fakeDriver(async driver => {
      credential = registry.byModelCapability(capability);
      assert.ok(credential && !credential.revoked);
      driver.emitEvent("message.delta", { delta: "working" });
      await driver.waitCancel();
    });
    const cancel = driver.cancel;
    driver.cancel = async () => {
      atCancel.revoked = credential.revoked;
      atCancel.aborted = credential.signal.aborted;
      atCancel.lookup = await models.lookup(capability);
      await cancel();
    };
    return driver;
  });
  const logs = [];
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  // In-flight model/tool calls follow credential.signal, so they were aborted before the stop.
  assert.deepEqual(atCancel, { revoked: true, aborted: true, lookup: null });
  assert.equal(state.completes.length, 0);
  assert.equal(registry.size, 0);
  assert.ok(logs.some(l => l.code === "LEASE_LOST"));
});

test("cancel received by a heartbeat during allocation aborts opening and settles CANCELLED", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  state.cancel = true;
  const registry = new RunCredentialRegistry();
  let openSignal;
  const launcher = {
    capabilities: { isolation: "container" },
    async open(request, signal) {
      openSignal = signal;
      // A slow allocation that honors the abort signal.
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
      });
    }
  };
  const logs = [];
  const started = Date.now();
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.ok(Date.now() - started < 5_000, "no wait for the allocation timeout");
  assert.equal(openSignal.aborted, true);
  assert.ok(state.syncs.length >= 1);
  assert.ok(!state.syncs.some(s => s.started), "nothing was reported as started");
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
  assert.equal(state.completes[0].outcome.answer, undefined);
  assert.equal(registry.size, 0);
  assert.ok(!logs.some(l => l.code === "SANDBOX_UNAVAILABLE"));
});

test("a definite sync rejection fails the Run at once instead of waiting for the lease", async t => {
  const { state, control } = await fakeEngine(t, {
    sync: ({ body, fault }) => {
      if (body.events?.length) {
        fault("ai_invalid_input");
        return true;
      }
      return false;
    }
  });
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "rejected text" });
      await driver.waitCancel();
    })
  );
  const logs = [];
  const started = Date.now();
  await lane(control, launcher, registry, logs).execute(
    lease(),
    state.claimToken,
    new AbortController().signal
  );
  // The lease is 30s; a retry loop would have run until then.
  assert.ok(Date.now() - started < 5_000);
  assert.ok(launcher.drivers[0].cancels >= 1);
  assert.equal(launcher.closed, 1);
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "FAILED");
  assert.equal(state.completes[0].outcome.error.code, "sync_rejected");
  // The Purefect control plane maps the Engine fault onto the neutral code.
  assert.match(state.completes[0].outcome.error.message, /\(invalid_input\)/);
  assert.equal(logs.filter(l => l.code === "SYNC_REJECTED").length, 1);
  assert.ok(!logs.some(l => l.code === "SYNC_RETRY" && l.error === "invalid_input"));
  assert.equal(registry.size, 0);
});

test("the Codex adapter prepares its thread but starts no turn that was not admitted", async () => {
  const run = async gate => {
    const methods = [];
    const events = [];
    const timings = [];
    let observer;
    const emit = value => observer.stdout(Buffer.from(JSON.stringify(value) + "\n"));
    const adapter = new CodexRunAdapter({
      workspace: "/workspace",
      onTiming: (_run, phase, elapsedMs) => timings.push({ phase, elapsedMs }),
      transport: {
        async start(value) {
          observer = value;
        },
        async write(bytes) {
          const message = JSON.parse(bytes);
          if (message.method) methods.push(message.method);
          if (message.method === "initialize") emit({ id: message.id, result: {} });
          if (message.method === "thread/start")
            emit({ id: message.id, result: { thread: { id: "thread-1" } } });
        },
        async stop() {
          return { state: "exited", code: 0, signal: null };
        }
      }
    });
    adapter.on("event", event => events.push(event.type));
    const executing = adapter.execute({
      runId: "run-1",
      prompt: "Hello",
      expiresAt: Date.now() + 10_000,
      beforeTurn: gate.admission,
      ...(gate.origin !== undefined ? { timingOrigin: gate.origin } : {})
    });
    await until(() => methods.includes("thread/start"));
    await new Promise(resolve => setTimeout(resolve, 20));
    await gate.settle(adapter);
    await executing;
    return { methods, events, timings };
  };
  const refused = await run({
    admission: () => Promise.reject(new Error("RUN_NOT_STARTED")),
    settle: async () => {},
    // The lane passes its claim time: Driver phases are measured from it.
    origin: performance.now() - 1_000
  });
  assert.deepEqual(refused.methods, ["initialize", "initialized", "thread/start"]);
  assert.deepEqual(refused.events, ["run.failed"]);
  assert.equal(refused.timings[0].phase, "driver-start");
  assert.ok(refused.timings[0].elapsedMs >= 1_000);
  // Cancellation while waiting for admission ends the Run without a turn.
  const cancelled = await run({
    admission: () => new Promise(() => {}),
    settle: adapter => adapter.cancel()
  });
  assert.deepEqual(cancelled.methods, ["initialize", "initialized", "thread/start"]);
  assert.deepEqual(cancelled.events, ["run.cancelled"]);
  assert.deepEqual(cancelled.timings[0], { phase: "driver-start", elapsedMs: 0 });
});

test("a sandbox without container isolation is refused unless explicitly allowed", async t => {
  const { control } = await fakeEngine(t);
  const local = { ...fakeLauncher(() => {}), capabilities: { isolation: "local" } };
  assert.throws(() => lane(control, local, new RunCredentialRegistry(), []), {
    message: "SANDBOX_ISOLATION_REQUIRED"
  });
  assert.doesNotThrow(() =>
    lane(control, local, new RunCredentialRegistry(), [], { allowLocalSandbox: true })
  );
});

test("conversation files: downloaded by the lane, staged with a manifest; signed URLs stay in the lane", async t => {
  const { state, control } = await fakeEngine(t);
  const signed = "https://oss.example.test/f/1?Signature=url-secret-" + "u".repeat(40);
  const files = [
    {
      file_id: "9001",
      name: "季度报表.xlsx",
      content_type: "application/octet-stream",
      size: 5,
      relation: "input",
      loaded: true,
      url: signed,
      expires_at: Date.now() + 300_000
    },
    { file_id: "9002", name: "too big.pdf", size: 9, relation: "output", loaded: false }
  ];
  state.pending.push({ ...lease(), credentials: { ...lease().credentials, files } });
  const downloads = [];
  const download = async (url, init) => {
    downloads.push({ url, redirect: init.redirect });
    return new Response("hello", { headers: { "content-length": "5" } });
  };
  const contexts = [];
  const context = {
    turn: async request => {
      contexts.push(request);
      return new FrozenInputContext("System.").turn(request);
    }
  };
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "ok" });
      driver.emitEvent("run.completed");
    })
  );
  const logs = [];
  const recorder = new StatusRecorder({ queues: ["interactive"], concurrency: 1 });
  const worker = lane(control, launcher, new RunCredentialRegistry(), logs, {
    download,
    context,
    observe: recorder.lane(0)
  });
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.completes.length > 0);
  worker.drain();
  abort.abort();
  await running;
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  assert.deepEqual(downloads, [{ url: signed, redirect: "error" }]);
  assert.equal(contexts[0].inputFiles, true);
  const request = launcher.requests[0];
  assert.deepEqual(
    request.inputs.map(input => input.name),
    ["file.xlsx", "manifest.json"]
  );
  assert.equal(Buffer.from(request.inputs[0].data).toString(), "hello");
  const manifest = JSON.parse(Buffer.from(request.inputs[1].data).toString());
  assert.deepEqual(
    manifest.map(entry => [entry.name, entry.path, entry.loaded]),
    [
      ["季度报表.xlsx", "file.xlsx", true],
      ["too big.pdf", null, false]
    ]
  );
  assert.ok(launcher.drivers[0].input.instructions.includes("/workspace/inputs"));
  // File mode reaches the Driver (its CLI policy); the gateway grant follows the same lease.
  assert.equal(launcher.drivers[0].input.fileTools, true);
  assert.ok(logs.some(log => log.code === "INPUT_FILES_STAGED" && log.loaded === 1));
  // The URL is in none of: the sandbox request, the Driver input, logs, events or status.
  const leaked = [request, launcher.drivers[0].input, logs, state.syncs, recorder.snapshot?.()];
  for (const value of leaked)
    assert.ok(
      !(JSON.stringify(value ?? null) + inspect(value, { depth: 8 })).includes("url-secret-")
    );
});

test("conversation files: a sandbox that cannot take them fails the Run with a definite code", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const files = [
    {
      file_id: "9001",
      name: "a.txt",
      relation: "input",
      loaded: true,
      url: "https://oss.example.test/a",
      expires_at: Date.now() + 300_000
    }
  ];
  const launcher = fakeLauncher(() => {
    throw new Error("INPUTS_UNAVAILABLE");
  });
  await lane(control, launcher, new RunCredentialRegistry(), [], {
    download: async () => new Response("x")
  }).execute(
    { ...lease(), credentials: { ...lease().credentials, files } },
    state.claimToken,
    new AbortController().signal
  );
  assert.deepEqual(state.completes[0].outcome.error, {
    code: "input_files_unavailable",
    message: "The conversation files could not be placed into the sandbox"
  });
});

test("memory admission: a lane defers claiming while memory is low, then claims", async t => {
  const { state, control } = await fakeEngine(t);
  const verdicts = ["low", "low", "low", "admit"];
  let checks = 0;
  const admission = {
    check: async () => verdicts[Math.min(checks++, verdicts.length - 1)]
  };
  const logs = [];
  const observed = [];
  const worker = lane(
    control,
    fakeLauncher(() => {}),
    new RunCredentialRegistry(),
    logs,
    {
      admission,
      admissionRetryMs: 10,
      observe: event => observed.push(event)
    }
  );
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.claims.length > 0);
  worker.drain();
  abort.abort();
  await running;
  assert.ok(checks >= 4);
  assert.deepEqual(
    logs.filter(log => log.code === "CLAIM_DEFERRED"),
    [{ code: "CLAIM_DEFERRED", reason: "memory" }]
  );
  assert.ok(observed.some(event => event.type === "lane" && event.error === "MEMORY_LOW"));
  // No claim was sent while memory was low.
  const firstClaim = observed.findIndex(event => event.state === "claiming");
  assert.equal(observed.slice(firstClaim).filter(event => event.error === "MEMORY_LOW").length, 0);
});

/** A lease in file mode chosen by the control plane (no conversation files). */
function fileModeLease(changes = {}) {
  const base = lease();
  return { ...base, run: { ...base.run, file_tools: true, ...changes } };
}

const GENERATED = "generated-secret-content-" + "g".repeat(20);

test("generated files: read after the CLI, checked and reported before complete; logs carry no names or content", async t => {
  const { state, control } = await fakeEngine(t);
  state.pending.push(fileModeLease());
  const journal = state.log;
  const launcher = fakeLauncher(
    () =>
      fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "见 [月报.csv](outputs/月报.csv)" });
        driver.emitEvent("run.completed");
      }),
    journal
  );
  launcher.outputs = async () => ({
    files: [
      { name: "月报.csv", data: Buffer.from(`a,=HYPERLINK("x")\n${GENERATED},-5\n`) },
      { name: "宏.xlsm", data: Buffer.from("PK") }
    ],
    rejected: [{ name: "link.pdf", reason: "not_regular_file" }]
  });
  const contexts = [];
  const logs = [];
  const worker = lane(control, launcher, new RunCredentialRegistry(), logs, {
    context: {
      turn: async request => {
        contexts.push(request);
        return new FrozenInputContext("System.").turn(request);
      }
    }
  });
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.completes.length > 0);
  worker.drain();
  abort.abort();
  await running;
  // File mode without files: the manifest alone is written, the Driver gets its file tools.
  assert.equal(contexts[0].inputFiles, true);
  assert.deepEqual(
    launcher.requests[0].inputs.map(input => input.name),
    ["manifest.json"]
  );
  assert.equal(launcher.drivers[0].input.fileTools, true);
  assert.ok(launcher.drivers[0].input.instructions.includes("/workspace/outputs"));
  // Outputs are read before the sandbox stops and reported before complete.
  assert.ok(journal.indexOf("outputs") > journal.indexOf("execute"));
  assert.ok(journal.lastIndexOf("output") < journal.indexOf("complete"));
  assert.equal(launcher.closed, 1);
  assert.deepEqual(
    state.outputs.map(o => [o.path, o.name, o.content_type ?? o.rejected, o.claim_token.length]),
    [
      ["outputs/月报.csv", "月报.csv", "text/csv", 43],
      ["outputs/宏.xlsm", "宏.xlsm", "macro", 43],
      ["outputs/link.pdf", "link.pdf", "not_regular_file", 43]
    ]
  );
  // The CSV formula is neutralized; the negative number is kept.
  assert.equal(
    Buffer.from(state.outputs[0].content_base64, "base64").toString(),
    `a,'=HYPERLINK("x")\n${GENERATED},-5\n`
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  assert.ok(logs.some(log => log.code === "OUTPUT_FILES_DELIVERED" && log.delivered === 1));
  const logged = JSON.stringify(logs);
  for (const secret of [GENERATED, "月报", "宏", "link.pdf"])
    assert.ok(!logged.includes(secret), secret);
});

test("generated files: a cancelled Run collects nothing", async t => {
  const { state, control } = await fakeEngine(t);
  state.pending.push(fileModeLease());
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "working" });
      await driver.waitCancel();
    })
  );
  let reads = 0;
  launcher.outputs = async () => {
    reads++;
    return { files: [{ name: "a.pdf", data: Buffer.from("%PDF-") }], rejected: [] };
  };
  const worker = lane(control, launcher, new RunCredentialRegistry(), []);
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.events.length > 0);
  state.cancel = true;
  await until(() => state.completes.length > 0);
  worker.drain();
  abort.abort();
  await running;
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
  assert.equal(reads, 0);
  assert.equal(state.outputs.length, 0);
});

test("generated files: failures to read or report never change the Run's outcome", async t => {
  for (const failure of ["read", "report"]) {
    const { state, control } = await fakeEngine(t, {
      output: ({ fault }) => (fault("ai_storage_failed"), true)
    });
    state.pending.push(fileModeLease());
    const launcher = fakeLauncher(() =>
      fakeDriver(async driver => {
        driver.emitEvent("message.delta", { delta: "done" });
        driver.emitEvent("run.completed");
      })
    );
    launcher.outputs = async () => {
      if (failure === "read") throw new Error("OUTPUTS_FAILED");
      return { files: [{ name: "a.pdf", data: Buffer.from("%PDF-1.7") }], rejected: [] };
    };
    const logs = [];
    const worker = lane(control, launcher, new RunCredentialRegistry(), logs);
    const abort = new AbortController();
    const running = worker.run(abort.signal);
    await until(() => state.completes.length > 0);
    worker.drain();
    abort.abort();
    await running;
    const { status, answer } = state.completes[0].outcome;
    assert.deepEqual({ status, answer }, { status: "SUCCEEDED", answer: "done" });
    if (failure === "read") {
      assert.equal(state.outputs.length, 0);
      assert.ok(
        logs.some(log => log.code === "OUTPUT_FILES_UNAVAILABLE" && log.error === "OUTPUTS_FAILED")
      );
    } else {
      // The upload failed; the file is then reported as upload_failed (also refused here).
      assert.deepEqual(
        state.outputs.map(o => o.rejected ?? "upload"),
        ["upload", "upload_failed"]
      );
      assert.ok(
        logs.some(
          log => log.code === "OUTPUT_FILE_REPORT_FAILED" && log.error === "ai_storage_failed"
        )
      );
    }
  }
});

/** The real Broker sandbox and transport over a fake Broker: the Driver stops its transport when
 * its turn ends (as the Codex and Claude Code Drivers do), which reads the generated files. */
function brokerSandbox(script, registry, { outputs } = {}) {
  const calls = [];
  let expiresAt;
  let capability;
  const fake = {
    calls,
    reads: [],
    status: async () => ({
      nodeId: "node-1",
      ready: true,
      managedLaunch: true,
      harnesses: ["codex"]
    }),
    allocateManaged: async (spec, authorization) => {
      calls.push("allocate");
      expiresAt = spec.expiresAt;
      capability = authorization.model.value;
      return {
        ref: {
          allocationId: spec.allocationId,
          tenantId: spec.tenantId,
          runId: spec.runId,
          generation: spec.generation
        },
        userId: spec.userId,
        expiresAt: spec.expiresAt,
        leaseExpiresAt: spec.leaseExpiresAt,
        state: "allocating"
      };
    },
    putInputs: async (ref, inputs) => (calls.push("inputs"), { ref, files: inputs.length }),
    getOutputs: async (ref, signal) => {
      calls.push("outputs");
      fake.reads.push(signal);
      return (outputs ?? (async () => ({ files: [], rejected: [] })))(signal);
    },
    renew: async value => ({ leaseExpiresAt: value.requestedExpiresAt }),
    terminate: async ref => (
      calls.push("terminate"),
      { ref, userId: "401", expiresAt, state: "terminated" }
    )
  };
  const launcher = new BrokerSandboxLauncher(fake, "node-1", {
    codex: binding => {
      const transport = new BrokerHarnessTransport(fake, binding);
      const driver = fakeDriver(script);
      const execute = driver.execute;
      const cancel = driver.cancel;
      driver.execute = async input => {
        try {
          await execute(input);
        } finally {
          await driver.dispose();
        }
      };
      // Whether the sandbox could still reach the model when the Driver was told to cancel.
      driver.cancel = async () => {
        calls.push(registry.byModelCapability(capability) ? "cancel (model reachable)" : "cancel");
        await cancel();
      };
      driver.dispose = async () => {
        driver.stopEvidence = await transport.stop();
      };
      return driver;
    }
  });
  return { fake, launcher };
}

test("generated files over the Broker sandbox: read when the CLI's turn ends, never on cancellation", async t => {
  // Turn completed: the transport's stop reads the files once; the Worker delivers them.
  {
    const { state, control } = await fakeEngine(t);
    state.claimToken = "c".repeat(43);
    const registry = new RunCredentialRegistry();
    const { fake, launcher } = brokerSandbox(
      async driver => {
        driver.emitEvent("message.delta", { delta: "done" });
        driver.emitEvent("run.completed");
      },
      registry,
      {
        outputs: async () => ({
          files: [{ name: "a.pdf", data: Buffer.from("%PDF-1.7") }],
          rejected: []
        })
      }
    );
    await lane(control, launcher, registry, []).execute(
      fileModeLease(),
      state.claimToken,
      new AbortController().signal
    );
    assert.deepEqual(fake.calls.slice(0, 4), ["allocate", "inputs", "outputs", "terminate"]);
    assert.equal(fake.calls.filter(call => call === "outputs").length, 1);
    assert.deepEqual(
      state.outputs.map(o => o.name),
      ["a.pdf"]
    );
    assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  }
  // Cancelled: gateway access ends before the Driver is told to cancel, and the stop reads
  // nothing (no CLI kept running for a read).
  {
    const { state, control } = await fakeEngine(t);
    state.claimToken = "c".repeat(43);
    const registry = new RunCredentialRegistry();
    const { fake, launcher } = brokerSandbox(async driver => {
      driver.emitEvent("message.delta", { delta: "working" });
      state.cancel = true;
      await driver.waitCancel();
    }, registry);
    await lane(control, launcher, registry, []).execute(
      fileModeLease(),
      state.claimToken,
      new AbortController().signal
    );
    assert.deepEqual(fake.calls.slice(0, 4), ["allocate", "inputs", "cancel", "terminate"]);
    assert.ok(!fake.calls.includes("outputs"), fake.calls.join());
    assert.equal(state.outputs.length, 0);
    assert.equal(state.completes[0].outcome.status, "CANCELLED");
  }
  // Worker shutdown: no read either.
  {
    const { state, control } = await fakeEngine(t);
    state.claimToken = "c".repeat(43);
    const registry = new RunCredentialRegistry();
    const shutdown = new AbortController();
    const { fake, launcher } = brokerSandbox(async driver => {
      driver.emitEvent("message.delta", { delta: "working" });
      shutdown.abort();
      await driver.waitCancel();
    }, registry);
    await lane(control, launcher, registry, []).execute(
      fileModeLease(),
      state.claimToken,
      shutdown.signal
    );
    assert.deepEqual(fake.calls.slice(0, 4), ["allocate", "inputs", "cancel", "terminate"]);
    assert.ok(!fake.calls.includes("outputs"), fake.calls.join());
    assert.equal(state.outputs.length, 0);
  }
});

test("generated files over the Broker sandbox: a cancellation during the read abandons it", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const registry = new RunCredentialRegistry();
  const { fake, launcher } = brokerSandbox(
    async driver => {
      driver.emitEvent("message.delta", { delta: "done" });
      driver.emitEvent("run.completed");
    },
    registry,
    {
      // A slow read (the Broker allows 30 s): ends only when abandoned.
      outputs: signal =>
        new Promise((_, reject) => {
          state.cancel = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    }
  );
  const started = Date.now();
  await lane(control, launcher, registry, []).execute(
    fileModeLease(),
    state.claimToken,
    new AbortController().signal
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(fake.reads.length, 1);
  assert.ok(fake.reads[0].aborted);
  assert.equal(state.outputs.length, 0);
  assert.equal(state.completes[0].outcome.status, "CANCELLED");
});

test("generated files: a cancellation during delivery stops the remaining reports", async t => {
  const { state, control } = await fakeEngine(t, {
    output: ({ reply, body, state }) => {
      // The first upload answers late, after a heartbeat carried the cancellation.
      state.cancel = true;
      setTimeout(
        () =>
          reply({
            protocol: "purefect-ai-execution/1",
            file_id: "file-1",
            name: body.name,
            content_type: body.content_type,
            size: 8
          }),
        150
      );
      return true;
    }
  });
  state.pending.push(fileModeLease());
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("message.delta", { delta: "done" });
      driver.emitEvent("run.completed");
    })
  );
  launcher.outputs = async () => ({
    files: ["a.pdf", "b.pdf", "c.pdf"].map(name => ({ name, data: Buffer.from("%PDF-1.7") })),
    rejected: []
  });
  const logs = [];
  const worker = lane(control, launcher, new RunCredentialRegistry(), logs);
  const abort = new AbortController();
  const running = worker.run(abort.signal);
  await until(() => state.completes.length > 0);
  worker.drain();
  abort.abort();
  await running;
  assert.deepEqual(
    state.outputs.map(o => o.name),
    ["a.pdf"]
  );
  assert.ok(logs.some(log => log.code === "OUTPUT_FILES_INCOMPLETE" && log.remaining === 2));
});

test("file_tools=false keeps a Run with files out of file mode; no file_tools falls back to files", async t => {
  const { state, control } = await fakeEngine(t);
  state.claimToken = "c".repeat(43);
  const files = [
    {
      file_id: "9001",
      name: "a.txt",
      relation: "input",
      loaded: true,
      url: "https://oss.example.test/a",
      expires_at: Date.now() + 300_000
    }
  ];
  const launcher = fakeLauncher(() =>
    fakeDriver(async driver => {
      driver.emitEvent("run.completed");
    })
  );
  launcher.outputs = async () => assert.fail("not in file mode");
  const downloads = [];
  const run = raw =>
    lane(control, launcher, new RunCredentialRegistry(), [], {
      download: async url => (downloads.push(url), new Response("x"))
    }).execute(raw, state.claimToken, new AbortController().signal);
  const base = lease();
  await run({
    ...base,
    run: { ...base.run, file_tools: false },
    credentials: { ...base.credentials, files }
  });
  assert.equal(launcher.requests[0].inputs, undefined);
  assert.equal(launcher.drivers[0].input.fileTools, undefined);
  assert.equal(downloads.length, 0);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

const MENTIONS = [
  { member_id: "11", name: "张三", is_digital: false },
  { member_id: "12", name: "财务助手", is_digital: true }
];
const DELEGATION_TOOLS = ["metadata.get_raw", "workspace_action", "propose_task", "report_task"];

/** Delegation: the Driver script gets the Run's MCP binding (as the tool gateway resolves it). */
async function delegationRun(t, run, script, { hooks, leaseMs, ...options } = {}) {
  const { state, control } = await fakeEngine(t, hooks);
  state.claimToken = "c".repeat(43);
  if (leaseMs) state.leaseMs = leaseMs;
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(
    registry,
    { serverId: "purefect", targetRef: "local", targetVersion: 1 },
    TOOL_CATALOG
  );
  const logs = [];
  const launcher = fakeLauncher(request =>
    fakeDriver(async (driver, input) => {
      const binding = await tools.lookup(request.toolCapability);
      await script({ driver, binding, request, state, input });
      driver.emitEvent("message.delta", { delta: "Done" });
      driver.emitEvent("run.completed");
    })
  );
  const base = lease();
  if (leaseMs) base.lease_until = Date.now() + leaseMs;
  await lane(control, launcher, registry, logs, {
    enabledTools: DELEGATION_TOOLS,
    ...options
  }).execute(
    { ...base, run: { ...base.run, ...run } },
    state.claimToken,
    new AbortController().signal
  );
  return { state, launcher, logs };
}
const controlTool = (binding, name) => binding.controlTools?.find(tool => tool.name === name);

test("propose_task: offered to a conversation Run with mentions; the call goes to ExecutionDomain::propose with the lease proof", async t => {
  const { state, logs } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: { prompt: "让 @财务助手 整理报销", history: [], mentions: MENTIONS }
    },
    async ({ binding, request, state, input }) => {
      // The CLI is told about it (enabled_tools / --allowedTools); the grant keeps gateway tools.
      assert.deepEqual(request.enabledTools, ["metadata.get_raw", "propose_task"]);
      assert.deepEqual(binding.enabledTools, ["metadata.get_raw"]);
      assert.deepEqual(
        binding.controlTools.map(tool => tool.name),
        ["propose_task"]
      );
      const tool = controlTool(binding, "propose_task");
      assert.deepEqual(tool.inputSchema.properties.assignee_member_id.enum, ["11", "12"]);
      assert.doesNotMatch(tool.description, /not supported yet/);
      assert.match(tool.description, /only when the user explicitly asks/);
      assert.deepEqual(tool.inputSchema.properties.repeat_rule.enum, [
        "daily",
        "weekdays",
        "weekly",
        "monthly",
        "cron"
      ]);
      // The note reaches the model with the mentions (default profile: context data).
      assert.match(input.contextData[0], /propose_task/);
      const signal = new AbortController().signal;
      const args = { assignee_member_id: "12", title: "整理十月报销", due_at: "2026-10-31 18:00" };
      const first = await tool.call(args, signal, "toolu_01ABC");
      assert.equal(first.failed, undefined);
      assert.match(first.text, /^Dispatched: the task went to digital employee "财务助手"/);
      assert.match(first.text, /task ID 901/);
      // A resend of one tool call (same tool call ID) carries the same request_id; another call does not.
      await tool.call(args, signal, "toolu_01ABC");
      await tool.call(args, signal, "toolu_02DEF");
      assert.deepEqual(
        state.proposes.map(p => p.request_id),
        ["toolu_01ABC", "toolu_01ABC", "toolu_02DEF"]
      );
    }
  );
  assert.deepEqual(state.proposes[0], {
    job_id: "101",
    generation: 1,
    claim_token: "c".repeat(43),
    request_id: "toolu_01ABC",
    assignee_member_id: "12",
    title: "整理十月报销",
    due_at: "2026-10-31 18:00"
  });
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  const calls = logs.filter(entry => entry.code === "CONTROL_TOOL_CALL");
  assert.equal(calls.length, 3);
  assert.deepEqual(
    { tool: calls[0].tool, outcome: calls[0].outcome, result: calls[0].result },
    { tool: "propose_task", outcome: "SUCCEEDED", result: "dispatched" }
  );
  assertNoSecrets(logs);
});

test("propose_task: platform refusals and bad arguments become short results for the model; the Run goes on", async t => {
  let replies = [];
  const { state } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: { prompt: "让 @张三 跟进", history: [], mentions: MENTIONS }
    },
    async ({ binding, state }) => {
      const tool = controlTool(binding, "propose_task");
      const signal = new AbortController().signal;
      const call = (args, id) => tool.call(args, signal, id);
      replies.push(await call({ assignee_member_id: "99", title: "x" }, "a1"));
      replies.push(await call({ assignee_member_id: "11", title: "  " }, "a2"));
      replies.push(await call({ assignee_member_id: "11", title: "t", due_at: "明天" }, "a3"));
      replies.push(await call({ assignee_member_id: "11", title: "t", priority: 1 }, "a4"));
      // None of the above reached the platform.
      assert.equal(state.proposes.length, 0);
      replies.push(await call({ assignee_member_id: "11", title: "跟进合同" }, "b1"));
      replies.push(await call({ assignee_member_id: "12", title: "整理报销" }, "b2"));
      replies.push(await call({ assignee_member_id: "11", title: "跟进合同" }, "b3"));
      replies.push(await call({ assignee_member_id: "11", title: "跟进合同" }, "b4"));
    },
    {
      hooks: {
        propose: ({ body, fault, reply }) => {
          if (body.request_id === "b1")
            reply({
              protocol: "purefect-ai-execution/1",
              result: "proposed",
              proposal_id: "201:b1"
            });
          else if (body.request_id === "b2") fault("task_execution_unsupported");
          else if (body.request_id === "b3") fault("ai_propose_assignee_not_mentioned");
          else fault("task_weird_fault");
          return true;
        }
      }
    }
  );
  assert.deepEqual(
    state.proposes.map(p => p.request_id),
    ["b1", "b2", "b3", "b4"]
  );
  const [notMentioned, blank, badDue, unknownKey, proposed, unsupported, refused, other] = replies;
  for (const reply of [notMentioned, blank, badDue, unknownKey]) {
    assert.equal(reply.failed, true);
    assert.match(reply.text, /^Invalid arguments, not dispatched/);
  }
  assert.match(notMentioned.text, /11, 12/);
  assert.match(badDue.text, /yyyy-MM-dd HH:mm/);
  assert.match(unknownKey.text, /priority/);
  assert.equal(proposed.failed, undefined);
  assert.match(proposed.text, /proposal ID 201:b1/);
  assert.match(proposed.text, /"张三" is a colleague/);
  assert.match(proposed.text, /do not say the task was dispatched/);
  assert.equal(unsupported.failed, true);
  assert.match(unsupported.text, /not permitted to assign tasks to this digital employee/);
  assert.match(refused.text, /only members the user @-mentioned/);
  assert.match(other.text, /^Not dispatched: the platform refused the request/);
  assert.doesNotMatch(other.text, /task_weird_fault/);
  // A refusal does not end the Run: no sync was rejected, and the Run settles SUCCEEDED.
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("propose_task: an unanswered request is resent with the same request_id, then reported as unknown", async t => {
  let answered = 0;
  const { state } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: { prompt: "让 @财务助手 整理报销", history: [], mentions: MENTIONS }
    },
    async ({ binding }) => {
      const tool = controlTool(binding, "propose_task");
      const signal = new AbortController().signal;
      // The first attempt is cut off (outcome unknown); the resend succeeds.
      const ok = await tool.call({ assignee_member_id: "12", title: "整理报销" }, signal, "c1");
      assert.equal(ok.failed, undefined);
      // Always cut off: once the resends are used up the model hears the outcome is unknown.
      const unknown = await tool.call({ assignee_member_id: "12", title: "整理报销" }, signal);
      assert.equal(unknown.failed, true);
      assert.match(unknown.text, /^Outcome unknown/);
      assert.match(unknown.text, /Do not automatically retry/);
    },
    {
      hooks: {
        propose: ({ body, res }) => {
          if (body.request_id === "c1" && answered++ > 0) return false;
          res.destroy();
          return true;
        }
      }
    }
  );
  const first = state.proposes.filter(p => p.request_id === "c1");
  assert.equal(first.length, 2);
  // Without a CLI tool call ID the Worker makes one, and its resends reuse it.
  const generated = state.proposes.filter(p => p.request_id !== "c1");
  assert.equal(generated.length, 3);
  assert.equal(new Set(generated.map(p => p.request_id)).size, 1);
  assert.match(generated[0].request_id, /^w[0-9a-f]{32}$/);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("report_task: offered to a task Run; each call becomes a task.reported sync event, in order, before complete", async t => {
  const { state, logs } = await delegationRun(
    t,
    {
      source: { type: "task", ref: "7001" },
      input: { prompt: "整理十月报销", history: [] }
    },
    async ({ driver, binding, request, state, input }) => {
      assert.deepEqual(request.enabledTools, ["metadata.get_raw", "report_task"]);
      const tool = controlTool(binding, "report_task");
      assert.deepEqual(tool.inputSchema.properties.status.enum, ["done", "needs_input", "failed"]);
      assert.match(input.contextData[0], /这是同事派给你的任务/);
      assert.match(input.contextData[0], /report_task/);
      driver.emitEvent("message.delta", { delta: "开始" });
      const signal = new AbortController().signal;
      const bad = await tool.call({ status: "ok", summary: "x" }, signal);
      assert.equal(bad.failed, true);
      assert.match(bad.text, /status must be one of done, needs_input, failed/);
      const empty = await tool.call({ status: "done", summary: " " }, signal);
      assert.equal(empty.failed, true);
      const first = await tool.call({ status: "needs_input", summary: "缺发票" }, signal);
      assert.equal(first.failed, undefined);
      assert.match(first.text, /^Recorded \(needs_input\)/);
      await tool.call({ status: "done", summary: "已整理 12 张发票，合计 3,400 元" }, signal);
      await until(() => state.events.filter(e => e.type === "task.reported").length === 2);
    }
  );
  const types = state.events.map(e => e.type);
  // Reports follow the earlier text and travel with the other events at contiguous offsets.
  assert.ok(types.indexOf("assistant.message.delta") < types.indexOf("task.reported"));
  assert.deepEqual(
    state.events.filter(e => e.type === "task.reported").map(e => e.data),
    [
      { status: "needs_input", summary: "缺发票" },
      { status: "done", summary: "已整理 12 张发票，合计 3,400 元" }
    ]
  );
  assert.equal(state.proposes.length, 0);
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  assert.ok(state.log.lastIndexOf("sync") < state.log.indexOf("complete"));
  assert.equal(logs.filter(entry => entry.code === "CONTROL_TOOL_CALL").length, 4);
});

test("delegation tools: none without run.source, for other sources, for a conversation without mentions, or when not enabled; run.tools does not narrow them", async t => {
  const cases = [
    [{ input: { prompt: "hi", history: [], mentions: MENTIONS } }, [], {}],
    [{ source: { type: "conversation", ref: "301" } }, [], {}],
    [
      { source: { type: "todo" }, input: { prompt: "hi", history: [], mentions: MENTIONS } },
      [],
      {}
    ],
    [{ source: { type: "task", ref: "7001" } }, [], { enabledTools: ["metadata.get_raw"] }],
    [{ source: { type: "task", ref: "7001" }, tools: ["metadata.get_raw"] }, ["report_task"], {}]
  ];
  for (const [run, expected, options] of cases) {
    const { state } = await delegationRun(
      t,
      run,
      async ({ binding, request, input }) => {
        assert.deepEqual(
          (binding.controlTools ?? []).map(tool => tool.name),
          expected
        );
        assert.deepEqual(request.enabledTools, ["metadata.get_raw", ...expected]);
        if (!expected.length)
          assert.doesNotMatch(input.contextData?.[0] ?? "", /report_task|propose_task/);
      },
      options
    );
    assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  }
  // Like the client action, control plane tools are not gateway tools: alone they are invalid.
  const { control } = await fakeEngine(t);
  assert.throws(
    () =>
      lane(
        control,
        fakeLauncher(() => fakeDriver(async () => {})),
        new RunCredentialRegistry(),
        [],
        {
          enabledTools: ["workspace_action", "propose_task", "report_task"]
        }
      ),
    /INVALID_LANE_CONFIGURATION/
  );
});

test("report_task after the Run's CLI finished is not recorded; the binding is gone with the Run", async t => {
  let tool;
  const { state } = await delegationRun(
    t,
    { source: { type: "task", ref: "7001" }, input: { prompt: "做事", history: [] } },
    async ({ binding }) => {
      tool = controlTool(binding, "report_task");
    }
  );
  const late = await tool
    .call({ status: "done", summary: "迟到的回报" }, new AbortController().signal)
    .catch(error => error);
  // The Run is over: the call is aborted with the revoked credential, or refused; nothing is queued.
  assert.ok(late instanceof Error || late.failed === true);
  assert.equal(state.events.filter(e => e.type === "task.reported").length, 0);
});

const reportedIn = body => body.events?.some(event => event.type === "task.reported");

test("report_task: a report still unconfirmed when the CLI ends is resent with backoff and reaches the Engine before complete", async t => {
  let failures = 0;
  const { state, logs } = await delegationRun(
    t,
    { source: { type: "task", ref: "7001" }, input: { prompt: "整理报销", history: [] } },
    async ({ binding }) => {
      const tool = controlTool(binding, "report_task");
      const result = await tool.call(
        { status: "done", summary: "已整理" },
        new AbortController().signal
      );
      assert.equal(result.failed, undefined);
      // The CLI ends right away: the report is delivered in the flush after it.
    },
    {
      hooks: {
        // The Engine fails every sync carrying the report eight times (more than the three
        // attempts that end an ordinary flush), then recovers.
        sync: ({ body, fault }) => {
          if (!reportedIn(body) || failures >= 8) return false;
          failures++;
          fault("sys_busy");
          return true;
        }
      }
    }
  );
  assert.equal(failures, 8);
  assert.deepEqual(
    state.events.filter(e => e.type === "task.reported").map(e => e.data),
    [{ status: "done", summary: "已整理" }]
  );
  assert.equal(state.completes.length, 1);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
  assert.ok(state.log.lastIndexOf("sync") < state.log.indexOf("complete"));
  assert.equal(logs.filter(entry => entry.code === "CONTROL_EVENTS_UNDELIVERED").length, 0);
});

test("report_task: when the lease leaves no room, the undelivered report is given up and logged, and the Run still settles", async t => {
  const { state, logs } = await delegationRun(
    t,
    { source: { type: "task", ref: "7001" }, input: { prompt: "整理报销", history: [] } },
    async ({ binding }) => {
      await controlTool(binding, "report_task").call(
        { status: "failed", summary: "查不到单据" },
        new AbortController().signal
      );
    },
    {
      leaseMs: 6_000,
      hooks: {
        sync: ({ body, fault }) => {
          if (!reportedIn(body)) return false;
          fault("sys_busy");
          return true;
        }
      }
    }
  );
  assert.equal(state.events.filter(e => e.type === "task.reported").length, 0);
  const given = logs.find(entry => entry.code === "CONTROL_EVENTS_UNDELIVERED");
  assert.ok(given, "the lane logs the report it gave up on");
  assert.ok(given.pending >= 1);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("report_task at the per-Run limit replaces the last unsent report, so the final report wins; with nothing to replace it is not recorded", async t => {
  let results;
  let late;
  const { state } = await delegationRun(
    t,
    { source: { type: "task", ref: "7001" }, input: { prompt: "做事", history: [] } },
    async ({ binding, state }) => {
      const tool = controlTool(binding, "report_task");
      const signal = new AbortController().signal;
      // Forty reports in one go, before any sync can carry them.
      results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          tool.call({ status: i === 39 ? "done" : "needs_input", summary: `r${i + 1}` }, signal)
        )
      );
      await until(() => state.events.filter(e => e.type === "task.reported").length === 32);
      // All 32 were carried by a sync: none is left to replace.
      late = await tool.call({ status: "failed", summary: "late" }, signal);
    }
  );
  assert.ok(results.every(result => result.failed === undefined));
  const reports = state.events.filter(e => e.type === "task.reported").map(e => e.data);
  assert.equal(reports.length, 32);
  assert.deepEqual(reports.at(-1), { status: "done", summary: "r40" });
  assert.deepEqual(reports.at(-2), { status: "needs_input", summary: "r31" });
  assert.equal(late.failed, true);
  assert.match(late.text, /^Not recorded/);
});

test("propose_task: one call at a time per Run, and at most five tasks handed out; a resend of a successful call still passes", async t => {
  let active = 0;
  let peak = 0;
  let replies;
  let resend;
  const { state } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: { prompt: "让 @财务助手 做这些", history: [], mentions: MENTIONS }
    },
    async ({ binding }) => {
      const tool = controlTool(binding, "propose_task");
      const signal = new AbortController().signal;
      replies = await Promise.all(
        Array.from({ length: 7 }, (_, i) =>
          tool.call({ assignee_member_id: "12", title: `事项 ${i + 1}` }, signal, `call_${i + 1}`)
        )
      );
      resend = await tool.call({ assignee_member_id: "12", title: "事项 1" }, signal, "call_1");
    },
    {
      hooks: {
        propose: ({ reply }) => {
          active++;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active--;
            reply({ protocol: "purefect-ai-execution/1", result: "dispatched", task_id: "901" });
          }, 10);
          return true;
        }
      }
    }
  );
  assert.equal(peak, 1, "calls of one Run never overlap");
  assert.deepEqual(
    state.proposes.map(p => p.request_id),
    ["call_1", "call_2", "call_3", "call_4", "call_5", "call_1"]
  );
  assert.equal(replies.filter(reply => reply.code === "dispatched").length, 5);
  const limited = replies.filter(reply => reply.code === "proposal_limit");
  assert.equal(limited.length, 2);
  for (const reply of limited) {
    assert.equal(reply.failed, true);
    assert.match(reply.text, /at most 5 tasks/);
  }
  assert.equal(resend.code, "dispatched");
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("lease adjustments are logged by code; a lease with too many mentions or an unknown source still runs", async t => {
  const { state, logs } = await delegationRun(
    t,
    {
      source: { type: "mail_v2", ref: "1" },
      input: {
        prompt: "hi",
        history: [],
        mentions: Array.from({ length: 12 }, (_, i) => ({ member_id: String(i + 1), name: "n" }))
      }
    },
    async ({ binding, input }) => {
      assert.equal(binding.controlTools, undefined);
      assert.equal((input.contextData[0].match(/成员 ID \d+/g) ?? []).length, 10);
    }
  );
  assert.deepEqual(
    logs.filter(entry => entry.code === "LEASE_ADJUSTED").map(entry => entry.adjustment),
    ["mentions_truncated", "source_type_unknown"]
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("task Runs: no page tool even with a page context, and calls needing approval are refused at once without relaying", async t => {
  const { state, turns, logs } = await confirmRun(
    t,
    { codes: ["*::delete"], uiContext: PAGE_CONTEXT, source: { type: "task", ref: "7001" } },
    async ({ binding, bridge, state }) => {
      assert.equal(binding.clientAction, undefined);
      assert.deepEqual(bridge.operations, ["*::delete"]);
      assert.equal(await bridge.confirm(ASK, new AbortController().signal), "unattended");
      // Nothing was relayed to a browser.
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(state.actions.length, 0);
    },
    { enabledTools: ["metadata.get_raw", "workspace_action"] }
  );
  assert.equal(turns[0].unattended, true);
  assert.equal(
    state.syncs.some(sync => sync.action_requests?.length),
    false
  );
  assert.deepEqual(
    logs.filter(entry => entry.code === "TOOL_CONFIRMATION").map(entry => entry.outcome),
    ["unattended"]
  );
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("conversation Runs keep the page tool and the approval bridge", async t => {
  const { state, turns } = await confirmRun(
    t,
    { codes: ["*::delete"], uiContext: PAGE_CONTEXT, source: { type: "conversation", ref: "301" } },
    async ({ binding, bridge, state }) => {
      assert.equal(binding.clientAction.name, "workspace_action");
      const pending = bridge.confirm(ASK, new AbortController().signal);
      await until(() => state.actions.length === 1);
      assert.equal(state.actions[0].op, "confirm");
      state.receipts.set(state.actions[0].action_id, {
        status: "SETTLED",
        receipt: { status: "succeeded", result: { approved: true } }
      });
      assert.equal(await pending, "approved");
    },
    { enabledTools: ["metadata.get_raw", "workspace_action"] }
  );
  assert.equal(turns[0].unattended, undefined);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("propose_task with a time rule: sent with the schedule fields; the proposed card names its first run", async t => {
  let reply;
  let bad;
  const { state } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: { prompt: "让 @财务助手 每个工作日早上 9 点汇总报销", history: [], mentions: MENTIONS }
    },
    async ({ binding, state }) => {
      const tool = controlTool(binding, "propose_task");
      const signal = new AbortController().signal;
      // A malformed rule never reaches the platform.
      bad = await tool.call(
        {
          assignee_member_id: "12",
          title: "汇总报销",
          trigger_type: "recurring",
          repeat_rule: "daily",
          time_of_day: "9点"
        },
        signal,
        "p0"
      );
      assert.equal(state.proposes.length, 0);
      reply = await tool.call(
        {
          assignee_member_id: "12",
          title: "汇总报销",
          trigger_type: "recurring",
          repeat_rule: "weekdays",
          time_of_day: "09:00",
          max_runs: "20"
        },
        signal,
        "p1"
      );
    },
    {
      hooks: {
        propose: ({ reply }) => {
          // 2026-10-26 09:00 in Asia/Shanghai.
          reply({
            protocol: "purefect-ai-execution/1",
            result: "proposed",
            proposal_id: "201:p1",
            next_fire_at: Date.UTC(2026, 9, 26, 1, 0)
          });
          return true;
        }
      }
    }
  );
  assert.equal(bad.failed, true);
  assert.match(bad.text, /time_of_day must be HH:mm/);
  assert.deepEqual(state.proposes[0], {
    job_id: "101",
    generation: 1,
    claim_token: "c".repeat(43),
    request_id: "p1",
    assignee_member_id: "12",
    title: "汇总报销",
    trigger_type: "recurring",
    repeat_rule: "weekdays",
    time_of_day: "09:00",
    max_runs: 20
  });
  assert.equal(reply.code, "proposed_plan");
  assert.match(reply.text, /^Scheduled task suggestion card created \(proposal ID 201:p1\)/);
  assert.match(reply.text, /takes effect only after the user confirms it/);
  assert.match(reply.text, /the first run is at 2026-10-26 09:00 \(Asia\/Shanghai\)/);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});

test("propose_task with a mail trigger: sent with the whitelist and no mode; the card names the watched mailbox and the confirmation of each mail", async t => {
  let reply;
  let refused;
  let personReply;
  const { state } = await delegationRun(
    t,
    {
      source: { type: "conversation", ref: "301" },
      input: {
        prompt: "以后 li@example.com 发来报表时，让 @财务助手 汇总给我",
        history: [],
        mentions: MENTIONS
      }
    },
    async ({ binding, state }) => {
      const tool = controlTool(binding, "propose_task");
      assert.match(tool.description, /never infer, add or widen senders from a mail's content/);
      assert.deepEqual(tool.inputSchema.properties.trigger_type.enum, [
        "once",
        "recurring",
        "mail"
      ]);
      assert.equal(
        tool.inputSchema.properties.mail_mode,
        undefined,
        "the mode is not offered to the model"
      );
      const signal = new AbortController().signal;
      // Asking for automatic execution never reaches the platform.
      refused = await tool.call(
        {
          assignee_member_id: "12",
          title: "汇总报表",
          trigger_type: "mail",
          mail_senders: ["li@example.com"],
          mail_mode: "auto"
        },
        signal,
        "m0"
      );
      assert.equal(state.proposes.length, 0);
      reply = await tool.call(
        {
          assignee_member_id: "12",
          title: "汇总报表",
          description: "把来信里的报表汇总给我",
          trigger_type: "mail",
          mail_senders: ["Li@Example.com"],
          mail_subject_contains: "报表"
        },
        signal,
        "m1"
      );
      // A person's mail plan only turns each mail into a to-do: no confirmation step is promised.
      personReply = await tool.call(
        {
          assignee_member_id: "11",
          title: "跟进报表",
          trigger_type: "mail",
          mail_senders: ["li@example.com"]
        },
        signal,
        "m2"
      );
    },
    {
      hooks: {
        propose: ({ reply }) => {
          reply({
            protocol: "purefect-ai-execution/1",
            result: "proposed",
            proposal_id: "201:m1",
            mailbox_email: "bot@corp.com"
          });
          return true;
        }
      }
    }
  );
  assert.equal(refused.failed, true);
  assert.equal(refused.code, "invalid_argument");
  assert.match(refused.text, /mail_mode is not accepted/);
  assert.deepEqual(state.proposes[0], {
    job_id: "101",
    generation: 1,
    claim_token: "c".repeat(43),
    request_id: "m1",
    assignee_member_id: "12",
    title: "汇总报表",
    description: "把来信里的报表汇总给我",
    trigger_type: "mail",
    mail_senders: ["li@example.com"],
    mail_subject_contains: "报表"
  });
  assert.equal(reply.code, "proposed_mail_plan");
  assert.match(reply.text, /^Mail-triggered task suggestion card created \(proposal ID 201:m1\)/);
  assert.match(reply.text, /watch the mailbox "bot@corp.com"/);
  assert.match(
    reply.text,
    /each matching mail waits for the user to confirm it before the digital employee works on it/
  );
  assert.match(personReply.text, /each matching mail becomes a to-do for that person/);
  assert.doesNotMatch(personReply.text, /waits for the user to confirm it/);
  assert.equal(state.completes[0].outcome.status, "SUCCEEDED");
});
