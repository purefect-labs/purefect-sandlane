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
import { errorCodeOf, StatusRecorder } from "../dist/status/recorder.js";
import {
  createStatusServer,
  StatusPanel,
  statusPanelConfig,
  tokenMatches
} from "../dist/status/server.js";

const TOKEN = "status-token-" + "t".repeat(40);
const WORKER = {
  version: "0.1.0",
  startedAt: Date.parse("2026-10-18T00:00:00Z"),
  runtimeId: "rt-1",
  nodeId: "node-1",
  harnesses: ["codex", "claude-code"]
};

function clock(start = Date.parse("2026-10-18T01:00:00Z")) {
  const c = { at: start, now: () => c.at };
  return c;
}

function runThrough(recorder, lane, run, { status = "SUCCEEDED", error, tools = 0 } = {}) {
  const observe = recorder.lane(lane);
  observe({ type: "run.started", run, harness: "codex" });
  for (const [phase, elapsedMs] of [
    ["claimed", 0],
    ["sandbox-ready", 410],
    ["started-acked", 450],
    ["turn-admitted", 900],
    ["first-text", 2100],
    ["turn-ended", 5200]
  ])
    observe({ type: "run.phase", run, phase, elapsedMs });
  for (let i = 0; i < tools; i++) recorder.observe({ type: "run.tool", run, ok: i % 2 === 0 });
  observe({ type: "run.ended", run, status, settlement: "settled", ...(error ? { error } : {}) });
}

test("lane states: claiming, running with its Run, back to idle; claim errors stay until a claim succeeds", () => {
  const c = clock();
  const recorder = new StatusRecorder({ queues: ["interactive"], concurrency: 2, now: c.now });
  const lane = recorder.lane(0);
  assert.deepEqual(
    recorder.snapshot().lanes.items.map(i => i.state),
    ["idle", "idle"]
  );
  lane({ type: "lane", state: "claiming" });
  c.at += 1000;
  lane({ type: "lane", state: "idle", error: "CONTROL_PLANE_UNAVAILABLE" });
  lane({ type: "lane", state: "claiming" });
  let item = recorder.snapshot().lanes.items[0];
  assert.equal(item.state, "claiming");
  assert.equal(item.lastError, "CONTROL_PLANE_UNAVAILABLE");
  // Claiming again right after claiming: the previous claim returned.
  lane({ type: "lane", state: "claiming" });
  assert.equal(recorder.snapshot().lanes.items[0].lastError, undefined);

  lane({ type: "run.started", run: "run-1", harness: "codex" });
  let snapshot = recorder.snapshot();
  item = snapshot.lanes.items[0];
  assert.equal(item.state, "running");
  assert.equal(snapshot.lanes.busy, 1);
  assert.equal(item.run, snapshot.runs.active[0].id);
  assert.equal(snapshot.runs.active[0].status, "running");
  assert.equal(snapshot.runs.active[0].lane, 0);
  c.at += 3000;
  lane({
    type: "run.ended",
    run: "run-1",
    status: "FAILED",
    settlement: "settled",
    error: "harness_failure"
  });
  snapshot = recorder.snapshot();
  assert.equal(snapshot.lanes.items[0].state, "idle");
  assert.equal(snapshot.lanes.items[0].run, undefined);
  assert.equal(snapshot.lanes.busy, 0);
  assert.deepEqual(snapshot.runs.active, []);
  assert.equal(snapshot.runs.recent[0].status, "FAILED");
  assert.equal(snapshot.runs.recent[0].error, "harness_failure");
  assert.equal(snapshot.runs.recent[0].durationMs, 3000);
  lane({ type: "lane", state: "stopped" });
  assert.equal(recorder.snapshot().lanes.items[0].state, "stopped");
  assert.equal(recorder.snapshot().lanes.items[1].state, "idle");
  assert.deepEqual(recorder.snapshot().lanes.queues, ["interactive"]);
  assert.throws(() => recorder.lane(2));
});

test("recent Runs are a bounded ring buffer, newest first, with phase timings and tool counts", () => {
  const recorder = new StatusRecorder({
    queues: ["q"],
    concurrency: 1,
    recentRuns: 3,
    runIds: "plain"
  });
  for (let i = 1; i <= 5; i++) runThrough(recorder, 0, `run-${i}`, { tools: i });
  const { runs } = recorder.snapshot();
  assert.equal(runs.capacity, 3);
  assert.deepEqual(
    runs.recent.map(r => r.id),
    ["run-5", "run-4", "run-3"]
  );
  const latest = runs.recent[0];
  assert.deepEqual(latest.phases, {
    claimed: 0,
    "sandbox-ready": 410,
    "started-acked": 450,
    "turn-admitted": 900,
    "first-text": 2100,
    "turn-ended": 5200
  });
  assert.deepEqual(Object.keys(latest.phases), [
    "claimed",
    "sandbox-ready",
    "started-acked",
    "turn-admitted",
    "first-text",
    "turn-ended"
  ]);
  assert.equal(latest.toolCalls, 5);
  assert.equal(latest.toolFailures, 2);
  assert.equal(latest.settlement, "settled");
  assert.equal(latest.harness, "codex");
  assert.match(latest.startedAt, /^\d{4}-\d\d-\d\dT/);
});

test("phases: first occurrence only, unknown phases and unknown Runs ignored", () => {
  const recorder = new StatusRecorder({ queues: ["q"], concurrency: 1, runIds: "plain" });
  const lane = recorder.lane(0);
  lane({ type: "run.started", run: "r", harness: "codex" });
  lane({ type: "run.phase", run: "r", phase: "first-text", elapsedMs: 100 });
  lane({ type: "run.phase", run: "r", phase: "first-text", elapsedMs: 900 });
  lane({ type: "run.phase", run: "r", phase: "prompt: secret", elapsedMs: 5 });
  lane({ type: "run.phase", run: "r", phase: "turn-ended", elapsedMs: -1 });
  lane({ type: "run.phase", run: "other", phase: "turn-ended", elapsedMs: 5 });
  recorder.observe({ type: "run.tool", run: "other", ok: true });
  assert.deepEqual(recorder.snapshot().runs.active[0].phases, { "first-text": 100 });
  assert.equal(recorder.snapshot().runs.active[0].toolCalls, 0);
});

test("gateway counters: calls, failures by error code, in flight while pending; codes are bounded", async () => {
  const recorder = new StatusRecorder({
    queues: ["q"],
    concurrency: 1,
    limits: { model: 4, tool: 4 }
  });
  let release;
  const pending = recorder.track("model", () => new Promise(resolve => (release = resolve)));
  assert.equal(recorder.snapshot().gateways.model.inFlight, 1);
  release("ok");
  assert.equal(await pending, "ok");
  const busy = Object.assign(new Error("MODEL_GATEWAY_BUSY"), {
    code: "MODEL_GATEWAY_BUSY",
    status: 429
  });
  await assert.rejects(
    recorder.track("model", async () => {
      throw busy;
    }),
    error => error === busy
  );
  await assert.rejects(
    recorder.track("tool", async () => {
      throw new Error("upstream said: key sk-live-123");
    })
  );
  let { model, tool } = recorder.snapshot().gateways;
  assert.deepEqual(model, {
    calls: 2,
    failed: 1,
    inFlight: 0,
    limit: 4,
    errors: { "MODEL_GATEWAY_BUSY:429": 1 }
  });
  assert.deepEqual(tool.errors, { UNEXPECTED: 1 });
  for (let i = 0; i < 20; i++)
    (recorder.observe({ type: "gateway.start", gateway: "tool" }),
      recorder.observe({ type: "gateway.end", gateway: "tool", ok: false, error: `CODE_${i}` }));
  tool = recorder.snapshot().gateways.tool;
  assert.equal(Object.keys(tool.errors).length, 17);
  assert.equal(tool.errors.OTHER, 5);
  assert.equal(tool.failed, 21);
  assert.equal(errorCodeOf(new Error("a message with spaces")), "UNEXPECTED");
  assert.equal(
    errorCodeOf(Object.assign(new Error("MODEL_UPSTREAM_REJECTED"), { status: 401 })),
    "MODEL_UPSTREAM_REJECTED:401"
  );
});

test("upstream preconnects: counts and the last result", () => {
  const recorder = new StatusRecorder({ queues: ["q"], concurrency: 1 });
  assert.deepEqual(recorder.snapshot().upstream, { preconnects: 0, failures: 0 });
  recorder.observe({ type: "upstream.preconnect", ok: true, elapsedMs: 312.4 });
  recorder.observe({ type: "upstream.preconnect", ok: false, error: "ECONNRESET" });
  const { upstream } = recorder.snapshot();
  assert.equal(upstream.preconnects, 1);
  assert.equal(upstream.failures, 1);
  assert.equal(upstream.last.ok, false);
  assert.equal(upstream.last.error, "ECONNRESET");
});

test("Run identifiers: keyed short hash by default, plain or sequence when configured", () => {
  const hashed = new StatusRecorder({ queues: ["q"], concurrency: 1 });
  runThrough(hashed, 0, "1234567");
  const id = hashed.snapshot().runs.recent[0].id;
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(hashed.snapshot().runs.idMode, "hash");
  // Per process key: another recorder hashes the same Run differently.
  const other = new StatusRecorder({ queues: ["q"], concurrency: 1 });
  runThrough(other, 0, "1234567");
  assert.notEqual(other.snapshot().runs.recent[0].id, id);
  const none = new StatusRecorder({ queues: ["q"], concurrency: 1, runIds: "none" });
  runThrough(none, 0, "1234567");
  assert.equal(none.snapshot().runs.recent[0].id, "#1");
  assert.ok(!JSON.stringify(hashed.snapshot()).includes("1234567"));
  assert.ok(!JSON.stringify(none.snapshot()).includes("1234567"));
});

/** Identifier-shaped values that must never be shown: they only arrive as Run IDs (hashed) or in
 * fields the recorder does not know. */
const IDENTITY = [
  "sk-model-secret-xyz",
  "agent-token-secret",
  "user-401-private",
  "tenant-acme-private"
];
/** Free text (prompts, answers, tool data, provider messages): refused in every code field. */
const TEXT = [
  "prompt text: please summarize",
  "tool argument value",
  "answer text here",
  "Bearer leaked",
  "upstream said: invalid key"
];
const SENSITIVE = [...IDENTITY, ...TEXT];

/** Feeds sensitive values into every field an event could carry. */
function sensitiveRecorder() {
  const recorder = new StatusRecorder({ queues: ["q", TEXT[0]], concurrency: 1 });
  const lane = recorder.lane(0);
  lane({ type: "lane", state: "idle", error: TEXT[4] });
  lane({ type: "run.started", run: IDENTITY[2], harness: TEXT[1], user: IDENTITY[2] });
  lane({ type: "run.phase", run: IDENTITY[2], phase: TEXT[0], elapsedMs: 3 });
  lane({
    type: "run.ended",
    run: IDENTITY[2],
    status: "FAILED",
    settlement: "settled",
    error: TEXT[2]
  });
  lane({
    type: "run.started",
    run: IDENTITY[3],
    harness: "codex",
    prompt: TEXT[0],
    tenant: IDENTITY[3],
    key: IDENTITY[0]
  });
  recorder.observe({ type: "run.tool", run: IDENTITY[3], ok: false, arguments: TEXT[1] });
  recorder.observe({ type: "gateway.start", gateway: "model" });
  recorder.observe({ type: "gateway.end", gateway: "model", ok: false, error: TEXT[3] });
  recorder.observe({ type: "upstream.preconnect", ok: false, error: TEXT[4] });
  recorder.observe({ type: "upstream.preconnect", ok: true, elapsedMs: "1e3" });
  recorder.observe({ type: "nonsense", value: IDENTITY[1] });
  recorder.observe(null);
  recorder.observe({ type: "gateway.start", gateway: "__proto__" });
  return recorder;
}

test("malformed and sensitive inputs never reach the snapshot, and observe never throws", async () => {
  const recorder = sensitiveRecorder();
  const panel = new StatusPanel(recorder, WORKER, async () => ({
    ready: true,
    active: 1,
    capacity: 5,
    idleSessions: 2,
    network: "isolated",
    harnesses: ["codex", TEXT[0]],
    token: IDENTITY[1],
    tenants: { [IDENTITY[3]]: 1 },
    lastError: TEXT[4]
  }));
  const text = JSON.stringify(await panel.document());
  for (const value of SENSITIVE) assert.ok(!text.includes(value), `leaked ${value}`);
  const document = JSON.parse(text);
  assert.equal(document.runs.recent[0].harness, "unknown");
  assert.equal(document.runs.recent[0].error, "INVALID");
  assert.equal(document.lanes.items[0].state, "running");
  assert.deepEqual(document.lanes.queues, ["q"]);
  assert.deepEqual(document.sandbox.harnesses, ["codex"]);
  assert.equal(document.sandbox.active, 1);
  assert.equal(document.sandbox.token, undefined);
  assert.equal(document.gateways.model.errors.INVALID, 1);
  assert.equal(document.lanes.items[0].run, document.runs.active[0].id);
  assert.equal(document.runs.active[0].toolFailures, 1);
  assert.equal(document.upstream.last.elapsedMs, undefined);
});

test("the panel document: Worker identity, cached sandbox status, unreachable sandbox", async () => {
  const c = clock();
  let calls = 0;
  let fail = false;
  const recorder = new StatusRecorder({ queues: ["q"], concurrency: 1, now: c.now });
  const panel = new StatusPanel(
    recorder,
    WORKER,
    async signal => {
      calls++;
      assert.ok(signal instanceof AbortSignal);
      if (fail) throw new Error("connect ENOENT /control/broker.sock");
      return {
        ready: true,
        nodeId: "node-1",
        active: 0,
        capacity: 5,
        perTenant: 2,
        queuedOperations: 0
      };
    },
    c.now
  );
  const [a, b] = await Promise.all([panel.document(), panel.document()]);
  assert.equal(calls, 1);
  assert.deepEqual(a.sandbox, b.sandbox);
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.worker.uptimeMs, 3_600_000);
  assert.equal(a.worker.startedAt, "2026-10-18T00:00:00.000Z");
  assert.deepEqual(a.worker.harnesses, ["codex", "claude-code"]);
  assert.equal(a.sandbox.reachable, true);
  assert.equal(a.sandbox.capacity, 5);
  await panel.document();
  assert.equal(calls, 1, "cached");
  c.at += 2_500;
  fail = true;
  const down = await panel.document();
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(down.sandbox).sort(), ["checkedAt", "error", "reachable"]);
  assert.equal(down.sandbox.reachable, false);
  assert.equal(down.sandbox.error, "UNAVAILABLE");
});

test("configuration: off without SANDLANE_STATUS_PORT; loopback by default; invalid values refused", async () => {
  assert.equal(await statusPanelConfig({}), undefined);
  assert.equal(await statusPanelConfig({ SANDLANE_STATUS_BIND: "0.0.0.0" }), undefined);
  const config = await statusPanelConfig({ SANDLANE_STATUS_PORT: "19445" });
  assert.deepEqual(
    { ...config, hosts: [...config.hosts] },
    { bind: "127.0.0.1", port: 19445, token: undefined, runIds: "hash", recentRuns: 50, hosts: [] }
  );
  const full = await statusPanelConfig({
    SANDLANE_STATUS_PORT: "19445",
    SANDLANE_STATUS_BIND: "0.0.0.0",
    SANDLANE_STATUS_TOKEN: TOKEN,
    SANDLANE_STATUS_RUN_IDS: "plain",
    SANDLANE_STATUS_RECENT_RUNS: "100",
    SANDLANE_STATUS_HOSTS: "status.internal"
  });
  assert.equal(full.token, TOKEN);
  assert.deepEqual([...full.hosts], ["status.internal"]);
  for (const env of [
    { SANDLANE_STATUS_PORT: "0" },
    { SANDLANE_STATUS_PORT: "70000" },
    { SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_BIND: "localhost" },
    { SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_TOKEN: "short" },
    { SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_RUN_IDS: "raw" },
    { SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_RECENT_RUNS: "0" },
    { SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_HOSTS: "bad host" }
  ])
    await assert.rejects(statusPanelConfig(env), /SANDLANE_STATUS_/);
  // Errors name the variable, never the value.
  await assert.rejects(
    statusPanelConfig({ SANDLANE_STATUS_PORT: "19445", SANDLANE_STATUS_TOKEN: "short-secret" }),
    error => !error.message.includes("short-secret")
  );
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, TOKEN + "x"), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
});

async function serve(t, options = {}) {
  const recorder = sensitiveRecorder();
  runThrough(recorder, 0, "run-a");
  const panel = new StatusPanel(recorder, WORKER, async () => ({
    ready: true,
    active: 0,
    capacity: 5
  }));
  const server = createStatusServer(panel, { token: options.token, hosts: options.hosts ?? [] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const request = (path, { method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: { host: `127.0.0.1:${port}`, ...headers }
        },
        res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString()
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
  return { request, port };
}

test("HTTP: read-only page and JSON with no-store, security headers and a nonce-only CSP", async t => {
  const { request } = await serve(t);
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  const csp = page.headers["content-security-policy"];
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.match(csp, /default-src 'none'/);
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.ok(page.body.includes(`<script nonce="${nonce}">`));
  assert.ok(page.body.includes(`<style nonce="${nonce}">`));
  // Self-contained: no external resources.
  assert.ok(!/(src|href)=["']?https?:/i.test(page.body));
  assert.notEqual(
    nonce,
    /'nonce-([^']+)'/.exec((await request("/")).headers["content-security-policy"])[1]
  );
  for (const response of [page, await request("/status.json")]) {
    assert.equal(response.headers["cache-control"], "no-store, max-age=0");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  const json = await request("/status.json");
  assert.match(json.headers["content-type"], /^application\/json/);
  const document = JSON.parse(json.body);
  assert.equal(document.worker.runtimeId, "rt-1");
  assert.equal(document.sandbox.capacity, 5);
  assert.equal(document.runs.recent[0].status, "SUCCEEDED");
  for (const value of SENSITIVE) assert.ok(!json.body.includes(value), `leaked ${value}`);
  assert.ok(!json.body.includes("run-a"), "hashed Run id by default");
  const head = await request("/status.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("HTTP: only GET/HEAD on two paths; foreign Host names are refused", async t => {
  const { request, port } = await serve(t, { hosts: ["status.internal"] });
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await request("/status.json", { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  assert.equal((await request("/admin")).status, 404);
  assert.equal((await request("/status.json/")).status, 404);
  assert.equal((await request("/", { headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await request("/", { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request("/", { headers: { host: "status.internal" } })).status, 200);
});

test("HTTP: with a token every request needs Bearer or ?token=", async t => {
  const { request } = await serve(t, { token: TOKEN });
  for (const path of ["/", "/status.json"]) {
    const denied = await request(path);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["www-authenticate"], "Bearer");
    assert.ok(!denied.body.includes("worker"));
    assert.equal((await request(path, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await request(`${path}?token=wrong`)).status, 401);
    assert.equal(
      (await request(path, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
      200
    );
    assert.equal((await request(`${path}?token=${TOKEN}`)).status, 200);
  }
  // The page never embeds the token; its script reads it from the address.
  const page = await request(`/?token=${TOKEN}`);
  assert.ok(!page.body.includes(TOKEN));
  assert.equal((await request(`/status.json?token=${TOKEN}&token=${TOKEN}`)).status, 401);
});
