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
import { ModelGateway, modelDigest } from "../dist/gateway/model/gateway.js";

const capability = "c".repeat(43);
const runtime = { runtimeId: "runtime", allocationId: "allocation" };
const secret = "provider-private-key-" + "s".repeat(32);
const request = () => ({ callId: "call-1", modelAlias: "analysis", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 });
const permit = () => ({ tenantId: "10", runId: "200", callId: "call-1", providerId: "approved", providerModel: "model-a",
  secretRef: "tenant-10-model-key", bindingVersion: 1, maxOutputTokens: 100, receipt: "r".repeat(43) });
function setup(overrides = {}, settings) {
  const seen = { reserves: [], dispatches: [], finishes: [], secrets: [], calls: [] };
  const authority = {
    async reserve(input, signal) { seen.reserves.push(input); return overrides.reserve ? overrides.reserve(input, signal) : permit(); },
    async dispatch(input, signal) { seen.dispatches.push(input); if (overrides.dispatch) await overrides.dispatch(input, signal); },
    async finish(input, signal) { seen.finishes.push(input); if (overrides.finish) await overrides.finish(input, signal); }
  };
  const secrets = { async read(input, signal) { seen.secrets.push(input); return overrides.secret ? overrides.secret(input, signal) : secret; } };
  const provider = { async invoke(input, key, signal) { seen.calls.push({ input, key }); return overrides.invoke ? overrides.invoke(input, key, signal) : { text: "answer", usage: { inputTokens: 10, outputTokens: 5 } }; } };
  return { seen, gateway: new ModelGateway(authority, secrets, new Map([["approved", provider]]), settings) };
}
async function rejectsCode(action, code) { await assert.rejects(action, e => e.code === code); }
async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test("model gateway freezes input, binds digest and withholds success until receipt commits", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const { gateway, seen } = setup({ reserve: async () => { entered(); await blocked; return permit(); } });
  const input = request(); const original = structuredClone(input);
  const running = gateway.invoke(capability, runtime, input); await waiting;
  input.messages[0].content = "tampered"; input.modelAlias = "unauthorized"; release();
  assert.deepEqual(await running, { text: "answer", usage: { inputTokens: 10, outputTokens: 5 } });
  assert.equal(seen.calls[0].input.messages[0].content, "hello");
  assert.equal(seen.calls[0].input.model, "model-a");
  assert.equal(seen.reserves[0].call.requestDigest, modelDigest({ modelAlias: original.modelAlias, messages: original.messages, maxOutputTokens: 100 }));
  assert.deepEqual(seen.secrets[0], { permit: permit(), capability, runtime });
  assert.ok(Object.isFrozen(seen.secrets[0]));
  assert.ok(Object.isFrozen(seen.secrets[0].permit));
  assert.ok(Object.isFrozen(seen.secrets[0].runtime));
  assert.equal(seen.finishes[0].outcome, "SUCCEEDED");
  assert.equal(seen.finishes[0].outputTokens, 5);
  assert.deepEqual(seen.finishes[0].runtime, runtime);
});

test("identity, URL, headers, tools and oversized input cannot be smuggled into text contract", async () => {
  const { gateway, seen } = setup();
  for (const field of ["tenantId", "userId", "secretRef", "provider", "url", "headers", "tools", "stream"]) {
    await rejectsCode(() => gateway.invoke(capability, runtime, { ...request(), [field]: "override" }), "INVALID_MODEL_REQUEST");
  }
  await rejectsCode(() => gateway.invoke(capability, runtime, { ...request(), messages: [{ role: "tool", content: "x" }] }), "INVALID_MODEL_REQUEST");
  await rejectsCode(() => gateway.invoke(capability, runtime, { ...request(), messages: [{ role: "user", content: "x".repeat(32001) }] }), "MODEL_INPUT_LIMIT");
  await rejectsCode(() => gateway.invoke("wrong", runtime, request()), "MODEL_CAPABILITY_REQUIRED");
  assert.equal(seen.reserves.length, 0); assert.equal(seen.secrets.length, 0);
});

test("authorization and policy failures never resolve a secret or call a provider", async () => {
  const denied = setup({ reserve: () => { throw new Error("sensitive DB details " + secret); } });
  await rejectsCode(() => denied.gateway.invoke(capability, runtime, request()), "MODEL_REQUEST_REJECTED");
  assert.equal(denied.seen.secrets.length, 0); assert.equal(denied.seen.calls.length, 0);
  const changed = setup({ reserve: () => ({ ...permit(), callId: "other-call" }) });
  await rejectsCode(() => changed.gateway.invoke(capability, runtime, request()), "MODEL_AUTHORITY_PROTOCOL");
  assert.equal(changed.seen.secrets.length, 0);
  const unknown = setup({ reserve: () => ({ ...permit(), providerId: "http://unapproved" }) });
  await rejectsCode(() => unknown.gateway.invoke(capability, runtime, request()), "MODEL_PROVIDER_UNAVAILABLE");
  assert.equal(unknown.seen.secrets.length, 0); assert.equal(unknown.seen.finishes[0].outcome, "FAILED");
});

test("secret lookup failure is pre-dispatch failure; provider failure is unknown with no retry", async () => {
  const missing = setup({ secret: () => { throw new Error(secret); } });
  await rejectsCode(() => missing.gateway.invoke(capability, runtime, request()), "MODEL_REQUEST_REJECTED");
  assert.equal(missing.seen.calls.length, 0); assert.equal(missing.seen.finishes[0].outcome, "FAILED");
  const failed = setup({ invoke: () => { throw new Error(secret); } });
  await rejectsCode(() => failed.gateway.invoke(capability, runtime, request()), "MODEL_REQUEST_REJECTED");
  assert.equal(failed.seen.calls.length, 1); assert.equal(failed.seen.finishes[0].outcome, "UNKNOWN");
  assert.equal(failed.seen.finishes[0].inputTokens, null);
});

test("provider output cannot expose credentials, exceed limits or fabricate malformed usage", async () => {
  for (const output of [{ text: secret }, { text: capability }, { text: permit().receipt }, { text: "x".repeat(64001) }, { text: "ok", usage: { inputTokens: -1, outputTokens: 2 } }]) {
    const { gateway, seen } = setup({ invoke: () => output });
    await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_PROVIDER_PROTOCOL");
    assert.equal(seen.finishes[0].outcome, "UNKNOWN");
  }
  const { gateway } = setup({ invoke: () => ({ text: "safe", headers: { authorization: secret }, raw: secret }) });
  assert.deepEqual(await gateway.invoke(capability, runtime, request()), { text: "safe" });
});

test("unconfirmed accounting never publishes answer or retries a contradictory receipt", async () => {
  const { gateway, seen } = setup({ finish: () => { throw new Error(secret); } });
  await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_RECEIPT_UNCONFIRMED");
  assert.equal(seen.calls.length, 1); assert.equal(seen.finishes.length, 1);
  assert.equal(seen.finishes[0].outcome, "SUCCEEDED");
});

test("default model call permits a healthy response beyond thirty seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered, release, providerSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const output = new Promise(resolve => { release = resolve; });
  const { gateway, seen } = setup({ invoke: (_input, _key, signal) => {
    providerSignal = signal;
    entered();
    return output;
  } });
  const running = gateway.invoke(capability, runtime, request());
  // Attach immediately so a regression to the old timer is reported as an assertion failure.
  const outcome = running.then(value => ({ value }), error => ({ error }));
  await started;
  t.mock.timers.tick(31000);
  assert.equal(providerSignal.aborted, false);
  release({ text: "long reply completed", usage: { inputTokens: 10, outputTokens: 100 } });
  assert.equal((await outcome).value?.text, "long reply completed");
  assert.equal(seen.finishes[0].outcome, "SUCCEEDED");
});

test("deadline aborts provider work and concurrent admission is bounded", async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const { gateway, seen } = setup({ invoke: (_input, _key, signal) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) }, { maxConcurrent: 1, timeoutMs: 80, receiptTimeoutMs: 50 });
  const first = gateway.invoke(capability, runtime, request()); await started;
  await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_GATEWAY_BUSY");
  await assert.rejects(first); assert.equal(seen.finishes.length, 1); assert.equal(seen.finishes[0].outcome, "UNKNOWN");
  assert.equal(seen.calls.length, 1);
});

test("parallel calls use separate tenant credentials on actual provider connections", async t => {
  const captured = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    captured.push({ auth: req.headers.authorization, model: body.model, prompt: body.messages[0].content });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: body.model + ":" + body.messages[0].content }));
  });
  const providerBase = await listen(provider); t.after(() => close(provider));
  const finished = [];
  const authority = {
    async reserve(input) { const id = input.capability === capability ? "10" : "11"; return { ...permit(), tenantId: id, providerModel: "model-" + id, secretRef: "key-" + id, callId: input.call.callId }; },
    async dispatch() {},
    async finish(input) { finished.push(input); }
  };
  const gateway = new ModelGateway(authority, { async read({ permit: { tenantId, secretRef }, capability: cap, runtime: allocation }) {
    assert.equal(cap, tenantId === "10" ? capability : "d".repeat(43));
    assert.equal(allocation.allocationId, "a-" + tenantId);
    assert.equal(secretRef, "key-" + tenantId); return "tenant-private-provider-key-" + tenantId;
  } },
    new Map([["approved", { async invoke(input, key, signal) {
      return (await fetch(providerBase, { method: "POST", headers: { authorization: "Bearer " + key }, body: JSON.stringify(input), signal })).json();
    } }]]));
  const replies = await Promise.all(["10", "11"].map(id => gateway.invoke(id === "10" ? capability : "d".repeat(43),
    { runtimeId: "runtime", allocationId: "a-" + id },
    { ...request(), callId: "call-" + id, messages: [{ role: "user", content: "tenant-prompt-" + id }] })));
  assert.deepEqual(replies.map(r => r.text), ["model-10:tenant-prompt-10", "model-11:tenant-prompt-11"]);
  for (const id of ["10", "11"]) assert.ok(captured.some(c => c.auth === "Bearer tenant-private-provider-key-" + id && c.model === "model-" + id && c.prompt === "tenant-prompt-" + id));
  assert.equal(finished.length, 2); assert.ok(finished.every(f => f.outcome === "SUCCEEDED"));
});

test("tenant zero and frozen original allocation survive model settlement", async () => {
  const original = { ...runtime };
  const { gateway, seen } = setup({ reserve: () => { original.allocationId = "changed"; return { ...permit(), tenantId: "0" }; } });
  await gateway.invoke(capability, original, request());
  assert.equal(seen.finishes[0].permit.tenantId, "0");
  assert.deepEqual(seen.finishes[0].runtime, runtime);
  const failed = setup({ invoke: () => { throw new Error("provider disconnected"); } });
  await assert.rejects(() => failed.gateway.invoke(capability, runtime, request()));
  assert.equal(failed.seen.finishes[0].outcome, "UNKNOWN");
  assert.deepEqual(failed.seen.finishes[0].runtime, runtime);
});

test("aborted authorization or secret lookup cannot proceed to provider IO", async () => {
  for (const phase of ["reserve", "secret"]) {
    const controller = new AbortController();
    const overrides = phase === "reserve" ? { reserve: () => { controller.abort(); return permit(); } }
      : { secret: () => { controller.abort(); return secret; } };
    const { gateway, seen } = setup(overrides);
    await assert.rejects(() => gateway.invoke(capability, runtime, request(), controller.signal));
    assert.equal(seen.calls.length, 0);
    assert.ok(seen.finishes.every(f => f.outcome === "FAILED"));
  }
});

test("revocation during Secret lookup is checked before provider dispatch", async () => {
  let revoked = false;
  const { gateway, seen } = setup({ secret: () => { revoked = true; return secret; },
    dispatch: () => { assert.equal(revoked, true); throw new Error("user was revoked"); } });
  await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_REQUEST_REJECTED");
  assert.equal(seen.dispatches.length, 1); assert.equal(seen.calls.length, 0);
  assert.equal(seen.finishes[0].outcome, "FAILED");
});

test("lost dispatch acknowledgement never causes an unconfirmed provider send", async () => {
  const { gateway, seen } = setup({ dispatch: () => { throw new Error("acknowledgement lost"); } });
  await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_REQUEST_REJECTED");
  assert.equal(seen.dispatches.length, 1); assert.equal(seen.calls.length, 0);
  assert.equal(seen.finishes.length, 1); assert.equal(seen.finishes[0].outcome, "FAILED");
});

test("authority IDs cannot be coerced from unsafe JSON numbers before Secret access", async () => {
  for (const override of [{ tenantId: 10 }, { runId: 200 }, { runId: 9223372036854775807 }, { bindingVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { gateway, seen } = setup({ reserve: () => ({ ...permit(), ...override }) });
    await rejectsCode(() => gateway.invoke(capability, runtime, request()), "MODEL_AUTHORITY_PROTOCOL");
    assert.equal(seen.secrets.length, 0); assert.equal(seen.dispatches.length, 0); assert.equal(seen.calls.length, 0);
  }
});
