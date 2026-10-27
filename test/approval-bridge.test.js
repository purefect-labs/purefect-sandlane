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
/** Approval bridge (scheme B): the Run's confirm policy, the gateway's confirmation phase, the
 * Purefect API code matching and summary, and the workbench verdict. */
import test from "node:test";
import assert from "node:assert/strict";
import { ToolGateway } from "../dist/gateway/tool/gateway.js";
import { CONFIRMATION_CODES, ToolCallFailed } from "../dist/spi/tool-provider.js";
import {
  callSummary,
  installPurefectTools,
  matchesApiCode,
  requiresConfirmation
} from "../dist/plugins/purefect/purefect-catalog.js";
import {
  parseConfirmApiCodes,
  parseLease,
  parseRunTools
} from "../dist/plugins/purefect/contract.js";
import { CONFIRMATION, WORKSPACE_ACTIONS } from "../dist/plugins/purefect/workspace-interaction.js";
import { apiInstructions, PurefectContext } from "../dist/plugins/purefect/context.js";
import { FrozenInputContext } from "../dist/core/turn-input.js";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { LocalToolAuthority } from "../dist/gateway/tool/local-authority.js";

const capability = "c".repeat(43);
const runtime = { runtimeId: "host", allocationId: "allocation" };
const TOKEN = "agent-token-secret-" + "x".repeat(40);

/** Gateway over the real Purefect adapter; `channel` is the Run's approval bridge (or none). */
function fixture(channel, limits) {
  const order = [];
  const receipts = [];
  const audit = [];
  const requests = [];
  const authority = {
    async reserve({ call, requestDigest }) {
      order.push("reserve");
      return {
        serverId: "purefect",
        serverVersion: 1,
        targetRef: "platform-dev",
        targetVersion: 3,
        toolVersion: 1,
        tenantId: "1",
        userId: "11",
        subjectUserId: "11",
        actorTenantAccessId: "101",
        credentialOwnerTenantAccessId: "101",
        runId: "21",
        attributes: { tenant_code: "one", site: "site-a" },
        callId: call.callId,
        toolAlias: call.toolAlias,
        requestDigest,
        credentialRef: "${secret://vault::test}",
        credentialRow: null,
        bindingVersion: 1,
        credentialVersion: 1,
        expiresAt: Date.now() + 30_000,
        receipt: "r".repeat(43)
      };
    },
    async dispatch() {
      order.push("dispatch");
    },
    async finish(result) {
      receipts.push(result.outcome);
    },
    ...(channel ? { confirmation: () => channel } : {})
  };
  const secrets = {
    async read() {
      order.push("read");
      return { accessToken: TOKEN, expiresAt: Date.now() + 30_000 };
    }
  };
  const installed = installPurefectTools(
    { gateway: "https://localhost:8443", targetRef: "platform-dev", targetVersion: 3, docs: {} },
    settings => ({
      async request(api, params) {
        order.push("platform");
        requests.push({ api, params, settings });
        return { success: true, data: { api } };
      }
    })
  );
  const adapter = installed.adapter;
  const gateway = new ToolGateway(
    authority,
    secrets,
    new Map([["purefect", adapter]]),
    limits,
    entry => audit.push(entry)
  );
  let serial = 0;
  const call = args =>
    gateway.invoke(capability, runtime, {
      callId: `call-${++serial}`,
      toolAlias: "purefect_call",
      arguments: args
    });
  return { adapter, call, order, receipts, audit, requests };
}

/** An approval bridge answering `verdict`, recording what it was asked. */
function channel(verdict, operations = ["*::delete", "pf.designer.meta.MetaManager::replace"]) {
  const asked = [];
  return {
    asked,
    operations,
    async confirm(request) {
      asked.push(request);
      return typeof verdict === "function" ? verdict(request) : verdict;
    }
  };
}

test("an approved call runs after the confirmation, with credentials read only then", async () => {
  const bridge = channel("approved");
  const f = fixture(bridge);
  const result = await f.call({
    api_code: "sales.order::delete",
    params: { id: "o-1", note: "duplicate" }
  });
  assert.deepEqual(result, { success: true, data: { api: "sales.order::delete" } });
  assert.deepEqual(bridge.asked, [
    {
      kind: "tool_call",
      tool: "purefect_call",
      title: "sales.order::delete",
      summary: 'api_code: sales.order::delete\nparams: id="o-1", note="duplicate"'
    }
  ]);
  assert.deepEqual(f.order, ["reserve", "read", "dispatch", "platform"]);
  assert.deepEqual(f.receipts, ["SUCCEEDED"]);
  assert.ok(!JSON.stringify(bridge.asked).includes(TOKEN));
});

test("declined, unanswered, unavailable and unattended confirmations never reach the platform", async () => {
  for (const verdict of ["rejected", "timeout", "unavailable", "unattended"]) {
    const f = fixture(channel(verdict));
    await assert.rejects(
      f.call({ api_code: "pf.designer.meta.MetaManager::replace", params: { code: "x" } }),
      error =>
        error instanceof ToolCallFailed &&
        error.code === CONFIRMATION_CODES[verdict] &&
        error.definite === true
    );
    // Nothing ran: no credential read, no dispatch, no platform request.
    assert.deepEqual(f.order, ["reserve"]);
    assert.deepEqual(f.receipts, ["FAILED"]);
    assert.deepEqual(
      f.audit.map(entry => [entry.outcome, entry.code]),
      [["FAILED", CONFIRMATION_CODES[verdict]]]
    );
  }
});

test("calls outside the policy, and Runs without one, are never asked (no overhead)", async () => {
  const bridge = channel("rejected");
  const f = fixture(bridge);
  await f.call({ api_code: "sales.order::search", params: {} });
  // Whole code, case-sensitive.
  await f.call({ api_code: "sales.order::Delete" });
  assert.equal(bridge.asked.length, 0);
  assert.deepEqual(f.receipts, ["SUCCEEDED", "SUCCEEDED"]);
  // No approval bridge (empty policy): the provider is not even consulted.
  const plain = fixture(undefined);
  let consulted = 0;
  const hook = plain.adapter.confirmation.bind(plain.adapter);
  plain.adapter.confirmation = (...args) => {
    consulted++;
    return hook(...args);
  };
  await plain.call({ api_code: "sales.order::delete" });
  assert.equal(consulted, 0);
  assert.deepEqual(plain.order, ["reserve", "read", "dispatch", "platform"]);
});

test("the wait for approval does not count against the call timeout", async () => {
  const bridge = channel(() => new Promise(resolve => setTimeout(() => resolve("approved"), 80)));
  const f = fixture(bridge, { concurrent: 2, timeoutMs: 40, receiptMs: 100 });
  assert.deepEqual(await f.call({ api_code: "a::delete" }), {
    success: true,
    data: { api: "a::delete" }
  });
});

test("a call waiting for the user holds no gateway slot: other calls go on meanwhile", async () => {
  let release;
  const bridge = channel(() => new Promise(resolve => (release = resolve)));
  const f = fixture(bridge, { concurrent: 1, timeoutMs: 1_000, receiptMs: 100 });
  const waiting = f.call({ api_code: "a::delete" });
  await new Promise(resolve => setTimeout(resolve, 20));
  // With a single slot, this would be TOOL_BUSY if the pending confirmation held it.
  assert.deepEqual(await f.call({ api_code: "a::search" }), {
    success: true,
    data: { api: "a::search" }
  });
  release("approved");
  assert.deepEqual(await waiting, { success: true, data: { api: "a::delete" } });
  // Both slots were returned: a further call still runs.
  assert.deepEqual(await f.call({ api_code: "a::get" }), {
    success: true,
    data: { api: "a::get" }
  });
});

test("nested calls cannot bypass an exact confirm pattern through another Domain path", async () => {
  const exact = "pf.x.MailManager::delete";
  assert.equal(requiresConfirmation("pf.x.MailManager::delete", exact), true);
  assert.equal(requiresConfirmation("pf.basis.user.UserDomain::mail::delete", exact), true);
  assert.equal(requiresConfirmation("a::b::c::delete", "*::del*"), true);
  // Plain Domain::service calls are matched as called; other services are not asked.
  assert.equal(requiresConfirmation("pf.y.Other::delete", exact), false);
  assert.equal(requiresConfirmation("pf.basis.user.UserDomain::mail::list", exact), false);
  const bridge = channel("approved", [exact]);
  const f = fixture(bridge);
  await f.call({ api_code: "pf.basis.user.UserDomain::mail::delete" });
  assert.equal(bridge.asked.length, 1);
});

test("a provider that cannot describe the call it wants confirmed makes it unavailable", async () => {
  for (const prompt of [
    () => {
      throw new Error("boom");
    },
    () => ({ title: "bad\u0007title", summary: "" }),
    () => ({ title: "", summary: "" }),
    () => ({ title: "t", summary: "x".repeat(1025) }),
    () => null
  ]) {
    const bridge = channel("approved");
    const f = fixture(bridge);
    f.adapter.confirmation = prompt;
    await assert.rejects(f.call({ api_code: "a::delete" }), {
      code: CONFIRMATION_CODES.unavailable
    });
    assert.equal(bridge.asked.length, 0);
    assert.deepEqual(f.order, ["reserve"]);
  }
});

test("API code patterns: * matches any run, the rest is literal and case-sensitive", () => {
  const cases = [
    ["*::delete", "sales.order::delete", true],
    ["*::delete", "sales.order::delete_all", false],
    ["*::delete*", "sales.order::delete_all", true],
    ["pf.designer.meta.MetaManager::*", "pf.designer.meta.MetaManager::replace", true],
    ["pf.designer.meta.MetaManager::*", "pf.designer.meta.MetaManagerX::replace", false],
    ["pf.*.MetaManager::replace", "pf.designer.meta.MetaManager::replace", true],
    ["a*b*c", "abc", true],
    ["a*b*c", "ac", false],
    ["a*a", "a", false],
    ["*", "anything::at_all", true],
    ["sales.order::delete", "sales.order::delete", true],
    ["sales.order::delete", "Sales.order::delete", false],
    // `.` is literal, not a regular expression wildcard.
    ["sales.order::delete", "salesXorder::delete", false]
  ];
  for (const [pattern, code, expected] of cases)
    assert.equal(matchesApiCode(code, pattern), expected, `${pattern} ~ ${code}`);
});

test("the summary is bounded and hides credential-like values", () => {
  const summary = callSummary({
    api_code: "sys.user::update",
    site: "blis",
    params: {
      name: "Alice",
      password: "hunter2-secret",
      accessToken: "abc",
      header: "Bearer abcdefghijklmnop",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      note: "n".repeat(500),
      rows: [1, 2, 3],
      data: { a: 1, b: 2 },
      count: 3,
      active: true,
      "bad\nkey": "v"
    }
  });
  const [code, site, params] = summary.split("\n");
  assert.equal(code, "api_code: sys.user::update");
  assert.equal(site, "site: blis");
  assert.match(
    params,
    /^params: name="Alice", password=\*\*\*, accessToken=\*\*\*, header=\*\*\*, jwt=\*\*\*/
  );
  assert.match(params, /note="n{48}…"/);
  assert.match(
    params,
    /rows=\[3 items\], data=\{2 fields\}, count=3, active=true, "bad\\nkey"="v"$/
  );
  for (const secret of ["hunter2", "abcdefghijklmnop", "eyJhbGci"])
    assert.ok(!summary.includes(secret));
  assert.equal(summary.split("\n").length, 3);
  const wide = callSummary({
    api_code: "a::b",
    params: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(60)]))
  });
  assert.ok(wide.length <= 1024);
  assert.match(callSummary({ api_code: "a::b" }), /params: \{\}$/);
});

test("the workbench verdict: only succeeded with approved === true approves", () => {
  const verdict = receipt => CONFIRMATION.verdict("act_1", { actionId: "act_1", ...receipt });
  assert.equal(verdict({ status: "succeeded", result: { approved: true } }), "approved");
  assert.equal(verdict({ status: "succeeded", result: { approved: false } }), "rejected");
  assert.equal(verdict({ status: "succeeded", result: { approved: "true" } }), "rejected");
  assert.equal(verdict({ status: "succeeded" }), "rejected");
  assert.equal(verdict({ status: "cancelled" }), "rejected");
  // The workbench's decline (also dismissed, closed or claim revoked) and its "cannot ask".
  assert.equal(verdict({ status: "failed", error: { code: "rejected" } }), "rejected");
  assert.equal(verdict({ status: "failed", error: { code: "unavailable" } }), "unavailable");
  assert.equal(
    verdict({ status: "succeeded", result: { approved: true }, error: { code: "rejected" } }),
    "rejected"
  );
  assert.equal(verdict({ status: "failed", error: { code: "timeout" } }), "timeout");
  assert.equal(verdict({ status: "failed", error: { code: "unsupported" } }), "unavailable");
  assert.equal(verdict({ status: "partial" }), "unavailable");
  assert.equal(verdict({ status: "approved" }), "unavailable");
  // Another action's receipt or a malformed one never approves.
  assert.equal(
    CONFIRMATION.verdict("act_1", {
      actionId: "act_2",
      status: "succeeded",
      result: { approved: true }
    }),
    "unavailable"
  );
  assert.equal(CONFIRMATION.verdict("act_1", "approved"), "unavailable");
  // The relayed action: op=confirm with exactly the request fields.
  assert.deepEqual(
    CONFIRMATION.request({ kind: "tool_call", tool: "purefect_call", title: "t", summary: "s" }),
    {
      op: "confirm",
      arguments: { kind: "tool_call", tool: "purefect_call", title: "t", summary: "s" }
    }
  );
});

test("confirmation is asked on every interaction-protocol turn, independent of the page tool", () => {
  const envelope = ui_context => ({
    prompt: JSON.stringify({ version: 1, prompt: "Delete it", ui_context }),
    promptFormat: "workspace-context-v1"
  });
  const protocol = "purefect-workspace-interaction/1";
  // The workbench claims these turns' actions: desktop with or without page operations, mobile.
  for (const context of [
    {
      workspace_action_protocol: protocol,
      surface: "console",
      interaction: 1,
      operations: ["open"]
    },
    { workspace_action_protocol: protocol, surface: "console" },
    { workspace_action_protocol: protocol, surface: "mobile" }
  ])
    assert.equal(WORKSPACE_ACTIONS.confirmation(envelope(context)), CONFIRMATION);
  // The page tool is not offered on these, the confirmation still is.
  assert.equal(
    WORKSPACE_ACTIONS.offer(envelope({ workspace_action_protocol: protocol, surface: "mobile" })),
    undefined
  );
  // No workbench that claims actions: nothing can be asked.
  for (const input of [
    envelope({ workspace_action_protocol: "purefect-workspace-action/1", operations: ["open"] }),
    envelope({ surface: "console" }),
    { prompt: "Delete it" },
    { prompt: JSON.stringify({ version: 1, prompt: "x" }), promptFormat: "workspace-context-v1" }
  ])
    assert.equal(WORKSPACE_ACTIONS.confirmation(input), undefined);
});

test("contract: run.confirm_api_codes becomes the neutral confirm policy; absent means none", () => {
  const now = Date.now();
  const raw = run => ({
    job_id: "1",
    generation: 1,
    lease_until: now + 1000,
    deadline_at: now + 9000,
    run: {
      run_id: "3",
      tenant_id: "0",
      conversation_id: "4",
      execution_profile: "sandbox",
      identity: { user_id: "5", tenant_code: "tenant-a", site: "site-a" },
      input: { prompt: "p" },
      input_digest: "f".repeat(64),
      ...run
    },
    credentials: {
      agent_token: { value: "tok", expires_at: now + 1000 },
      model_service: {
        base_uri: "https://m.example/v1",
        wire_api: "responses",
        model: "m1",
        api_key: "key"
      }
    }
  });
  // Platform serialization omits empty lists: absent, null and [] all mean no confirmation.
  for (const run of [{}, { confirm_api_codes: null }, { confirm_api_codes: [] }])
    assert.equal("confirm_operations" in parseLease(raw(run)).run, false);
  const lease = parseLease(
    raw({ confirm_api_codes: ["*::delete", "pf.designer.meta.MetaManager::replace", "*::delete"] })
  );
  assert.deepEqual(lease.run.confirm_operations, [
    "*::delete",
    "pf.designer.meta.MetaManager::replace"
  ]);
  assert.ok(Object.isFrozen(lease.run.confirm_operations));
  for (const codes of [
    "*::delete",
    ["bad code"],
    [""],
    [1],
    ["x".repeat(201)],
    Array.from({ length: 201 }, (_, i) => `a${i}::b`)
  ])
    assert.throws(() => parseConfirmApiCodes(codes), { code: "CONTROL_PLANE_PROTOCOL" });
});

test("lease: run.tools narrows the Run's tools; absent means no narrowing", () => {
  const now = Date.now();
  const raw = run => ({
    job_id: "1",
    generation: 1,
    lease_until: now + 1000,
    deadline_at: now + 9000,
    run: {
      run_id: "3",
      tenant_id: "0",
      conversation_id: "4",
      execution_profile: "sandbox",
      identity: { user_id: "5", tenant_code: "tenant-a", site: "site-a" },
      input: { prompt: "p" },
      input_digest: "f".repeat(64),
      ...run
    },
    credentials: {
      agent_token: { value: "tok", expires_at: now + 1000 },
      model_service: {
        base_uri: "https://m.example/v1",
        wire_api: "responses",
        model: "m1",
        api_key: "key"
      }
    }
  });
  assert.equal("tools" in parseLease(raw({})).run, false);
  const lease = parseLease(raw({ tools: ["purefect_call", "read_skill", "purefect_call"] }));
  assert.deepEqual(lease.run.tools, ["purefect_call", "read_skill"]);
  assert.ok(Object.isFrozen(lease.run.tools));
  assert.deepEqual(parseLease(raw({ tools: [] })).run.tools, []);
  for (const tools of [
    "purefect_call",
    ["bad tool"],
    [1],
    Array.from({ length: 51 }, (_, i) => `t${i}`)
  ])
    assert.throws(() => parseRunTools(tools), { code: "CONTROL_PLANE_PROTOCOL" });
});

test("instructions: read_skill is explained only when this Run offers it", () => {
  const without = apiInstructions(["purefect_call", "list_api_docs", "read_api_doc"]);
  assert.doesNotMatch(without, /read_skill/);
  const withSkills = apiInstructions(["purefect_call", "read_skill"]);
  assert.match(withSkills, /Purefect skill library .* not local CLI skills/);
  assert.match(withSkills, /first call read_skill with its code, then follow the returned text/);
  // Without purefect_call the skills rule still applies on its own.
  assert.match(apiInstructions(["read_skill"]), /^Purefect skills:/);
});

test("instructions: metadata is read through the runtime summary, never get_raw", () => {
  const text = apiInstructions(["purefect_call", "list_api_docs", "read_api_doc"]);
  assert.match(text, /MetaManager::get_meta_summary \{"type":"domain"/);
  assert.match(text, /use it first and as the default/);
  // get_raw appears only in the prohibition, never as something to call.
  assert.deepEqual(text.match(/[\w:.]*get_raw\w*/g), ["get_raw", "get_raw_summary"]);
  assert.match(text, /Do not use get_raw or get_raw_summary/);
});

test("instructions: confirmation rules only with a policy; failures are reported as returned", async () => {
  const tools = ["purefect_call", "list_api_docs", "read_api_doc"];
  const plain = apiInstructions(tools);
  assert.doesNotMatch(plain, /CONFIRMATION_/);
  assert.match(
    plain,
    /report its error code and message as returned; do not guess that it is a permission/
  );
  const codes = Array.from({ length: 12 }, (_, i) => `m${i}::delete`);
  const confirming = apiInstructions(tools, codes);
  assert.match(
    confirming,
    /approves the call in the workbench \(API codes matching: m0::delete, .*m9::delete and 2 more/
  );
  assert.match(confirming, /CONFIRMATION_REJECTED, the user declined/);
  assert.match(confirming, /None of these is a permission problem/);
  // Through the ContextProvider: the Run's policy arrives with the turn request.
  const context = new PurefectContext(new FrozenInputContext("BASE"), { enabledTools: tools });
  const turn = await context.turn(
    {
      runId: "1",
      conversationId: "2",
      tenantId: "3",
      userId: "4",
      input: { prompt: "Delete order 1", history: [] },
      webAccess: { mode: "off", domains: [] },
      confirmOperations: ["*::delete"]
    },
    new AbortController().signal
  );
  assert.match(turn.instructions, /API codes matching: \*::delete;/);
});

test("the local authority's bound tool keeps the audit summary and the confirmation hook", () => {
  const tools = new LocalToolAuthority(
    new RunCredentialRegistry(),
    { serverId: "purefect", targetRef: "local", targetVersion: 1 },
    [{ alias: "purefect_call", version: 1 }]
  );
  const { adapter } = fixture(undefined);
  const bound = tools.bind(adapter);
  const input = { callId: "c1", toolAlias: "purefect_call", arguments: { api_code: "a::delete" } };
  assert.deepEqual(bound.summarize(input), { api_code: "a::delete" });
  assert.equal(bound.confirmation(input, ["*::delete"]).title, "a::delete");
  assert.equal(bound.confirmation(input, ["*::update"]), undefined);
  // A Run without a bridge (unknown capability) has no confirmation channel.
  assert.throws(() => tools.confirmation({ capability, runtime }), /TOOL_IDENTITY_REQUIRED/);
});

test("unattended (task) Runs: no page actions or links in the instructions; approval patterns are explained as not runnable", async () => {
  const tools = ["purefect_call", "list_api_docs", "read_api_doc", "workspace_action"];
  const page = {
    workspace_action_protocol: "purefect-workspace-interaction/1",
    surface: "console",
    operations: ["describe", "open"],
    open_pages: [{ page: "sales.OrderList" }],
    interaction: 1
  };
  const context = new PurefectContext(new FrozenInputContext("BASE"), {
    enabledTools: tools,
    clientAction: WORKSPACE_ACTIONS
  });
  const request = {
    runId: "1",
    conversationId: "9",
    tenantId: "0",
    userId: "5",
    input: { prompt: "do it", history: [], ui_context: page },
    webAccess: { mode: "off" },
    confirmOperations: ["*::delete"]
  };
  const attended = (await context.turn(request)).instructions;
  assert.match(attended, /workspace_action/);
  assert.match(attended, /p-open:\/\//);
  assert.match(attended, /approves the call in the workbench/);
  const task = (await context.turn({ ...request, unattended: true })).instructions;
  assert.doesNotMatch(task, /workspace_action|p-open:|p-close:|workbench/);
  assert.match(task, /CONFIRMATION_UNATTENDED/);
  assert.match(task, /\*::delete/);
  // The plugin's own verdict: only conversation turns (or Runs without a source) are attended;
  // background sources are not.
  const lease = source => ({ run: { source } });
  for (const type of ["task", "todo", "schedule", "mail"])
    assert.equal(WORKSPACE_ACTIONS.attended(lease({ type, ref: "1" })), false, type);
  assert.equal(WORKSPACE_ACTIONS.attended(lease({ type: "conversation" })), true);
  assert.equal(WORKSPACE_ACTIONS.attended(lease(undefined)), true);
});
