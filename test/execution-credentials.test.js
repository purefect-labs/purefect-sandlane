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
import { inspect } from "node:util";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { LocalModelAuthority } from "../dist/gateway/model/local-authority.js";
import { ModelGateway, ModelGatewayError } from "../dist/gateway/model/gateway.js";
import { LocalToolAuthority } from "../dist/gateway/tool/local-authority.js";
import { ToolGateway } from "../dist/gateway/tool/gateway.js";

const CATALOG = [
  { alias: "metadata.get_raw", version: 1 },
  { alias: "metadata.get_meta", version: 1 }
];
const DEPLOYMENT = { serverId: "tools", targetRef: "local", targetVersion: 1 };

const MODEL_KEY = "sk-model-secret-" + "k".repeat(40);
const TOKEN = "agent-token-secret-" + "t".repeat(40);

const grant = (changes = {}) => ({
  jobId: "1",
  generation: 1,
  runId: "2",
  tenantId: "3",
  conversationId: "4",
  userId: "5",
  tenantAccessId: "50",
  attributes: { tenant_code: "acme", site: "site-a" },
  runtime: { runtimeId: "rt-1", allocationId: "run-2-g1" },
  harness: "codex",
  modelWire: "responses",
  modelAlias: "gpt-test",
  providerModel: "gpt-test",
  baseUri: "https://models.example.test/v1",
  enabledTools: ["metadata.get_raw"],
  expiresAt: Date.now() + 60000,
  ...changes
});
const secrets = (changes = {}) => ({
  modelKey: MODEL_KEY,
  agentToken: { value: TOKEN, expiresAt: Date.now() + 60000 },
  leaseUntil: Date.now() + 30000,
  ...changes
});
const request = { model: "gpt-test", input: "hello", stream: true };

test("registry keeps secrets private, renews tokens and revokes capabilities", () => {
  const registry = new RunCredentialRegistry();
  const credential = registry.register(grant(), secrets());
  const { model, tool } = credential.capabilities();
  assert.match(model, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(model, tool);
  assert.equal(registry.byModelCapability(model), credential);
  assert.equal(registry.byToolCapability(tool), credential);
  assert.equal(registry.byModelCapability(tool), undefined);
  for (const text of [
    JSON.stringify(credential),
    inspect(credential, { depth: 9 }),
    inspect(registry, { depth: 9 })
  ])
    assert.ok(!text.includes(MODEL_KEY) && !text.includes(TOKEN) && !text.includes(model));
  credential.renew(Date.now() + 40000, {
    value: "renewed-" + "r".repeat(40),
    expiresAt: Date.now() + 50000
  });
  assert.match(credential.agentToken().value, /^renewed-/);
  registry.revoke(credential);
  assert.equal(credential.signal.aborted, true);
  assert.equal(credential.modelKey(), undefined);
  assert.equal(credential.agentToken(), undefined);
  assert.equal(registry.byModelCapability(model), undefined);
  assert.equal(registry.byToolCapability(tool), undefined);
  assert.equal(registry.byId(credential.id), undefined);
  assert.equal(registry.size, 0);
});

test("token expiry refuses tool use; lease expiry without renewal aborts the Run signal", async () => {
  const registry = new RunCredentialRegistry();
  const credential = registry.register(
    grant(),
    secrets({
      agentToken: { value: TOKEN, expiresAt: Date.now() + 30 },
      leaseUntil: Date.now() + 80
    })
  );
  assert.equal(credential.toolUsable(), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(credential.toolUsable(), false);
  assert.equal(credential.agentToken(), undefined);
  assert.equal(credential.modelUsable(), true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(credential.signal.aborted, true);
  assert.equal(credential.modelKey(), undefined);
  // A late renewal cannot resurrect a lapsed lease.
  credential.renew(Date.now() + 30000, { value: TOKEN, expiresAt: Date.now() + 30000 });
  assert.equal(credential.modelUsable(), false);
  registry.revoke(credential);
});

test("local model authority resolves the Run's key and upstream, accumulates usage, rejects misuse", async () => {
  const registry = new RunCredentialRegistry();
  const created = [];
  const calls = [];
  const models = new LocalModelAuthority(
    registry,
    { functions: {}, maxOutputTokens: 1000 },
    {
      messages: () => assert.fail("no Messages upstream"),
      responses: baseUri => {
        created.push(baseUri);
        return {
          async invoke(req, model, secret, forbidden) {
            calls.push({ model, secret, forbidden });
            return { events: [], usage: { inputTokens: 3, outputTokens: 4 } };
          }
        };
      }
    }
  );
  const gateway = new ModelGateway(models, models, models.provider);
  const a = registry.register(grant(), secrets());
  const b = registry.register(
    grant({ runId: "9", runtime: { runtimeId: "rt-1", allocationId: "run-9-g1" } }),
    secrets({ modelKey: "sk-other-" + "o".repeat(40) })
  );
  models.admit(a);
  models.admit(b);
  assert.deepEqual(created, ["https://models.example.test/v1"]);
  const binding = await models.lookup(a.capabilities().model);
  assert.deepEqual(binding.runtime, { runtimeId: "rt-1", allocationId: "run-2-g1" });
  assert.equal(binding.maxOutputTokens, 1000);
  for (let i = 0; i < 2; i++)
    await gateway.respond(a.capabilities().model, binding.runtime, `c${i}`, request, binding);
  await gateway.respond(
    b.capabilities().model,
    (await models.lookup(b.capabilities().model)).runtime,
    "c9",
    request,
    binding
  );
  assert.deepEqual(
    calls.map(c => c.secret),
    [MODEL_KEY, MODEL_KEY, "sk-other-" + "o".repeat(40)]
  );
  assert.ok(calls[0].forbidden.includes(a.capabilities().model));
  assert.deepEqual(a.usage, { input_tokens: 6, output_tokens: 8 });
  assert.deepEqual(b.usage, { input_tokens: 3, output_tokens: 4 });
  // Wrong allocation binding, wrong model alias, foreign capability.
  await assert.rejects(
    gateway.respond(
      a.capabilities().model,
      { runtimeId: "rt-1", allocationId: "run-9-g1" },
      "x1",
      request,
      binding
    ),
    e => e instanceof ModelGatewayError && e.code === "MODEL_ACCESS_DENIED"
  );
  await assert.rejects(
    gateway.respond(
      a.capabilities().model,
      binding.runtime,
      "x2",
      { ...request, model: "other" },
      binding
    ),
    e => e.code === "MODEL_ACCESS_DENIED"
  );
  await assert.rejects(
    gateway.respond(a.capabilities().tool, binding.runtime, "x3", request, binding),
    e => e.code === "MODEL_ACCESS_DENIED"
  );
  registry.revoke(a);
  assert.equal(await models.lookup(a.capabilities().model), null);
  await assert.rejects(
    gateway.respond(a.capabilities().model, binding.runtime, "x4", request, binding),
    e => e.code === "MODEL_ACCESS_DENIED"
  );
  assert.equal(calls.length, 3);
  // The default upstream client accepts trusted path prefixes but never URL credentials/query.
  const strict = new LocalModelAuthority(registry, { functions: {}, maxOutputTokens: 1000 });
  assert.throws(() =>
    strict.admit(
      registry.register(
        grant({ baseUri: "https://m.example.test/custom/path?key=secret" }),
        secrets()
      )
    )
  );
  strict.admit(registry.register(grant({ baseUri: "https://m.example.test/v1" }), secrets()));
  strict.admit(
    registry.register(grant({ baseUri: "https://m.example.test/custom/path" }), secrets())
  );
});

test("revocation aborts an in-flight upstream model request", async () => {
  const registry = new RunCredentialRegistry();
  let observed;
  const models = new LocalModelAuthority(
    registry,
    { functions: {}, maxOutputTokens: 1000 },
    {
      messages: () => assert.fail("no Messages upstream"),
      responses: () => ({
        invoke: (req, model, secret, forbidden, signal) =>
          new Promise((_, reject) => {
            observed = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })
      })
    }
  );
  const gateway = new ModelGateway(models, models, models.provider);
  const credential = registry.register(grant(), secrets());
  const binding = await models.lookup(credential.capabilities().model);
  const pending = gateway.respond(
    credential.capabilities().model,
    binding.runtime,
    "c1",
    request,
    binding
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  registry.revoke(credential);
  await assert.rejects(pending, ModelGatewayError);
  assert.equal(observed.aborted, true);
});

test("local tool authority uses the current agent token and refuses after expiry", async () => {
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(registry, DEPLOYMENT, CATALOG);
  const seen = [];
  const gateway = new ToolGateway(
    tools,
    tools,
    new Map([
      [
        "tools",
        tools.bind({
          validate() {},
          async invoke(input, identity, token) {
            seen.push({ token, identity });
            return { ok: 1 };
          }
        })
      ]
    ])
  );
  const credential = registry.register(
    grant(),
    secrets({ agentToken: { value: TOKEN, expiresAt: Date.now() + 100 } })
  );
  const capability = credential.capabilities().tool;
  const binding = await tools.lookup(capability);
  assert.deepEqual(binding.enabledTools, ["metadata.get_raw"]);
  assert.ok(binding.expiresAt <= Date.now() + 100);
  const call = (id, alias = "metadata.get_raw") =>
    gateway.invoke(capability, binding.runtime, {
      callId: id,
      toolAlias: alias,
      arguments: { type: "model", code: "x" }
    });
  assert.deepEqual(await call("c1"), { ok: 1 });
  assert.equal(seen[0].token, TOKEN);
  assert.deepEqual(seen[0].identity.attributes, { tenant_code: "acme", site: "site-a" });
  await assert.rejects(call("c2", "metadata.get_meta"), /TOOL_CALL_REJECTED/);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await tools.lookup(capability), null);
  await assert.rejects(call("c3"), /TOOL_CALL_REJECTED/);
  assert.equal(seen.length, 1);
  registry.revoke(credential);
});

test("revocation aborts an in-flight downstream tool call", async () => {
  const registry = new RunCredentialRegistry();
  const tools = new LocalToolAuthority(registry, DEPLOYMENT, CATALOG);
  let observed;
  const gateway = new ToolGateway(
    tools,
    tools,
    new Map([
      [
        "tools",
        tools.bind({
          validate() {},
          invoke: (input, identity, token, signal) => {
            observed = signal;
            return new Promise(() => {});
          }
        })
      ]
    ])
  );
  const credential = registry.register(grant(), secrets());
  const binding = await tools.lookup(credential.capabilities().tool);
  const pending = gateway.invoke(credential.capabilities().tool, binding.runtime, {
    callId: "c1",
    toolAlias: "metadata.get_raw",
    arguments: { type: "model", code: "x" }
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  registry.revoke(credential);
  await assert.rejects(pending, /TOOL_RESULT_UNKNOWN/);
  assert.equal(observed.aborted, true);
});

test("warm-up reaches the Run's shared upstream only on request and never throws", () => {
  const registry = new RunCredentialRegistry();
  const warmed = [];
  const models = new LocalModelAuthority(
    registry,
    { functions: {}, maxOutputTokens: 1000 },
    {
      messages: () => assert.fail("no Messages upstream"),
      responses: baseUri => ({
        async invoke() {
          throw new Error("not called");
        },
        warm() {
          warmed.push(baseUri);
          if (baseUri.includes("broken")) throw new Error("socket failure");
        }
      })
    }
  );
  const credential = registry.register(grant(), secrets());
  models.admit(credential);
  assert.deepEqual(warmed, [], "validation alone opens no connection");
  models.warm(credential);
  assert.deepEqual(warmed, ["https://models.example.test/v1"]);
  models.warm(
    registry.register(grant({ runId: "9", baseUri: "https://broken.example.test/v1" }), secrets())
  );
  assert.equal(warmed.length, 2);
  // The default upstream rejects this base; warm() still returns quietly.
  const strict = new LocalModelAuthority(registry, { functions: {}, maxOutputTokens: 1000 });
  strict.warm(
    registry.register(grant({ runId: "10", baseUri: "https://m.example.test/x" }), secrets())
  );
});
