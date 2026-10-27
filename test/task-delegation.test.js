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
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { ControlPlaneError } from "../dist/spi/control-plane.js";
import { parseLease, parseProposeResponse, readLease } from "../dist/plugins/purefect/contract.js";
import { PapiControlPlane } from "../dist/plugins/purefect/control-plane.js";
import {
  parseDueAt,
  proposeArguments,
  proposeFailure,
  proposeRequestId,
  reportArguments,
  taskDelegationTools
} from "../dist/plugins/purefect/task-delegation.js";
import { FrozenInputContext } from "../dist/core/turn-input.js";
import { missingFunctions } from "../dist/common/function-inventory.js";
import { formatFireTime, scheduleArguments } from "../dist/plugins/purefect/task-schedule.js";
import { mailArguments, senderEntry } from "../dist/plugins/purefect/task-mail.js";
import { codexModelFunctions } from "../dist/harness/codex/codex-managed-config.js";
import { claudeCodeModelFunctions } from "../dist/harness/claude-code/claude-code-launcher.js";

const CONTRACT = new URL("../contract/ai-execution-v1.schema.json", import.meta.url);
const MENTIONS = [
  { member_id: "11", name: "张三", is_digital: false },
  { member_id: "12", name: "财务助手", is_digital: true }
];

function rawLease(run = {}, input = {}) {
  const now = Date.now();
  return {
    job_id: "1",
    generation: 2,
    lease_until: now + 1000,
    deadline_at: now + 9000,
    run: {
      run_id: "3",
      tenant_id: "0",
      conversation_id: "4",
      execution_profile: "sandbox",
      identity: { user_id: "5", tenant_code: "tenant-a", site: "site-a" },
      input: { prompt: "p", history: [], ...input },
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
  };
}

test("run.source: optional (older Engines); an unknown type means no source and a bad ref is dropped, never a rejected lease", async () => {
  assert.equal("source" in parseLease(rawLease()).run, false);
  assert.equal("source" in parseLease(rawLease({ source: null })).run, false);
  assert.deepEqual(
    parseLease(rawLease({ source: { type: "conversation", ref: "4" } })).run.source,
    {
      type: "conversation",
      ref: "4"
    }
  );
  // The Engine writes ref: null when the Run has no reference.
  assert.deepEqual(parseLease(rawLease({ source: { type: "task", ref: null } })).run.source, {
    type: "task"
  });
  assert.deepEqual(parseLease(rawLease({ source: { type: "schedule" } })).run.source, {
    type: "schedule"
  });
  assert.ok(
    Object.isFrozen(parseLease(rawLease({ source: { type: "task", ref: "9" } })).run.source)
  );
  // A newer Engine's source type: the Run still runs, without delegation tools.
  for (const source of [{}, { type: "chat", ref: "1" }, { type: 7 }]) {
    const read = readLease(rawLease({ source }), "t".repeat(43));
    assert.ok(read.lease, JSON.stringify(source));
    assert.equal("source" in read.lease.run, false);
    assert.deepEqual(read.adjustments, ["source_type_unknown"]);
  }
  for (const ref of [9, "", "a\nb", "x".repeat(257)]) {
    const read = readLease(rawLease({ source: { type: "task", ref } }), "t".repeat(43));
    assert.deepEqual(read.lease.run.source, { type: "task" }, JSON.stringify(ref));
    assert.deepEqual(read.adjustments, ["source_ref_invalid"]);
  }
  assert.equal(
    readLease(rawLease({ source: { type: "task", ref: "9" } }), "t".repeat(43)).adjustments,
    undefined
  );
  // Only a source that is not an object is malformed.
  assert.throws(() => parseLease(rawLease({ source: "conversation" })), ControlPlaneError);

  // The versioned schema accepts the same shapes the parser accepts.
  const schema = JSON.parse(await readFile(CONTRACT, "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(schema);
  const validateLease = ajv.compile({ $ref: "purefect-ai-execution/1#/$defs/lease" });
  for (const source of [{ type: "conversation", ref: "4" }, { type: "task" }])
    assert.equal(validateLease(rawLease({ source })), true, JSON.stringify(validateLease.errors));
  assert.equal(validateLease(rawLease({ source: { type: "chat" } })), false);
});

test("propose response: dispatched with a task ID or proposed with a proposal ID; other shapes are protocol errors", async () => {
  const protocol = "purefect-ai-execution/1";
  assert.deepEqual(parseProposeResponse({ protocol, result: "dispatched", task_id: "901" }), {
    result: "dispatched",
    task_id: "901"
  });
  // The platform names a proposal <run_id>:<request_id>, which may exceed an identifier's length.
  const long = `${"9".repeat(19)}:${"a".repeat(128)}`;
  assert.deepEqual(parseProposeResponse({ protocol, result: "proposed", proposal_id: long }), {
    result: "proposed",
    proposal_id: long
  });
  for (const value of [
    { protocol: "x", result: "dispatched", task_id: "1" },
    { protocol, result: "dispatched", task_id: 901 },
    { protocol, result: "dispatched" },
    { protocol, result: "proposed", proposal_id: "a b" },
    { protocol, result: "queued" }
  ])
    assert.throws(() => parseProposeResponse(value), ControlPlaneError);

  const schema = JSON.parse(await readFile(CONTRACT, "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(schema);
  const request = ajv.compile({ $ref: "purefect-ai-execution/1#/$defs/proposeRequest" });
  const response = ajv.compile({ $ref: "purefect-ai-execution/1#/$defs/proposeResponse" });
  const proof = { job_id: "1", generation: 1, claim_token: "t".repeat(43) };
  const args = proposeArguments(
    {
      assignee_member_id: "12",
      title: "整理报销",
      due_at: "2026-10-31 18:00",
      review_required: true
    },
    MENTIONS
  ).args;
  const body = { ...proof, request_id: proposeRequestId("toolu_01"), ...args };
  assert.equal(request(body), true, JSON.stringify(request.errors));
  assert.equal(request({ ...body, due_at: 1_761_900_000_000 }), true);
  assert.equal(response({ protocol, result: "proposed", proposal_id: "3:toolu_01" }), true);
});

test("propose request_id: stable for one tool call, distinct across calls, always a contract identifier", () => {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
  assert.equal(proposeRequestId("toolu_01ABC"), "toolu_01ABC");
  assert.equal(proposeRequestId("call_0"), proposeRequestId("call_0"));
  assert.notEqual(proposeRequestId("call_0"), proposeRequestId("call_1"));
  // IDs outside the identifier alphabet, too long or with a leading separator are digested.
  for (const odd of ["call/0", "_x", "x".repeat(101), "id with space"]) {
    const value = proposeRequestId(odd);
    assert.match(value, /^h[0-9a-f]{40}$/);
    assert.equal(value, proposeRequestId(odd));
  }
  assert.notEqual(proposeRequestId("call/0"), proposeRequestId("call/1"));
  // Without a CLI call ID every call gets a fresh one.
  const generated = proposeRequestId(undefined);
  assert.match(generated, /^w[0-9a-f]{32}$/);
  assert.notEqual(generated, proposeRequestId(undefined));
  for (const value of [generated, proposeRequestId("call/0"), proposeRequestId("toolu_01")])
    assert.match(value, pattern);
});

test("propose arguments: assignee among the mentions, bounded text, due_at as 13-digit ms or yyyy-MM-dd HH:mm", () => {
  assert.deepEqual(
    proposeArguments(
      {
        assignee_member_id: "11",
        title: "  跟进合同  ",
        description: "  ",
        due_at: null,
        review_required: false
      },
      MENTIONS
    ),
    { args: { assignee_member_id: "11", title: "跟进合同", review_required: false } }
  );
  assert.equal(parseDueAt("2026-10-31 18:00"), "2026-10-31 18:00");
  assert.equal(parseDueAt(1_761_900_000_000), 1_761_900_000_000);
  assert.equal(parseDueAt("1761900000000"), 1_761_900_000_000);
  for (const bad of [
    "2026-02-30 10:00",
    "2026-10-31 25:00",
    "2026/10/31 18:00",
    "2026-10-31T18:00",
    1_761_900_000,
    "1761900000",
    1.5,
    true
  ])
    assert.equal(parseDueAt(bad), null, String(bad));
  const problem = value => proposeArguments(value, MENTIONS).problem;
  assert.match(problem({ assignee_member_id: 12, title: "t" }), /assignee_member_id/);
  assert.match(problem({ assignee_member_id: "13", title: "t" }), /11, 12/);
  assert.match(problem({ assignee_member_id: "11", title: "x".repeat(201) }), /title/);
  assert.match(problem({ assignee_member_id: "11", title: "a\nb" }), /one line/);
  assert.match(
    problem({ assignee_member_id: "11", title: "t", description: "x".repeat(4001) }),
    /4000/
  );
  assert.match(
    problem({ assignee_member_id: "11", title: "t", review_required: "yes" }),
    /review_required/
  );
  assert.match(problem({ assignee_member_id: "11", title: "t", schedule: "daily" }), /schedule/);
  assert.match(problem([]), /object/);
  // 4000 characters (UTF-16, as the platform counts) are allowed.
  assert.ok(
    proposeArguments(
      { assignee_member_id: "11", title: "t", description: "长".repeat(4000) },
      MENTIONS
    ).args
  );
});

test("propose failures: business refusals are final, other platform faults temporary, no answer unknown; codes stay out of the text", () => {
  const refused = (code, kind = "CONTROL_PLANE_FAULT") =>
    proposeFailure(new ControlPlaneError(kind, code));
  assert.match(
    refused("ai_propose_assignee_not_mentioned", "CONTROL_PLANE_REJECTED").text,
    /@-mentioned/
  );
  assert.match(refused("task_execution_unsupported").text, /not permitted to assign tasks/);
  assert.match(refused("task_assignee_invalid").text, /cannot take tasks/);
  assert.match(refused("task_invalid").text, /Correct them and you may try once more/);
  assert.match(
    refused("ai_propose_unavailable", "CONTROL_PLANE_REJECTED").text,
    /cannot propose tasks/
  );
  assert.match(refused("invalid_input", "CONTROL_PLANE_REJECTED").text, /rejected the arguments/);
  assert.match(
    refused("ai_actor_unavailable", "CONTROL_PLANE_REJECTED").text,
    /access was withdrawn/
  );
  assert.match(refused("task_actor_unavailable").text, /access was withdrawn/);
  assert.match(refused("task_forbidden").text, /not permitted to create this task/);
  assert.match(refused("task_attachment_invalid").text, /attachment/);
  assert.match(refused("task_conflict").text, /try once more later/);
  // Unmapped business refusals: final, without the code in the text (the code is for the log).
  for (const [code, kind] of [
    ["task_something_new", "CONTROL_PLANE_FAULT"],
    ["ai_something_new", "CONTROL_PLANE_REJECTED"]
  ]) {
    const other = refused(code, kind);
    assert.equal(other.failed, true);
    assert.equal(other.code, code);
    assert.equal(
      other.text,
      "Not dispatched: the platform refused the request. Tell the user; do not call again."
    );
  }
  // Platform faults that are not business refusals (server error, lock timeout, execution off).
  for (const [code, kind] of [
    ["sys_lock_timeout", "CONTROL_PLANE_FAULT"],
    ["unknown", "CONTROL_PLANE_FAULT"],
    ["execution_disabled", "CONTROL_PLANE_REJECTED"]
  ]) {
    const temporary = refused(code, kind);
    assert.match(
      temporary.text,
      /^Not dispatched: the platform failed temporarily\. You may try once more later/
    );
    assert.doesNotMatch(temporary.text, new RegExp(code));
    assert.equal(temporary.code, code);
  }
  for (const error of [
    new ControlPlaneError("CONTROL_PLANE_UNAVAILABLE"),
    new ControlPlaneError("CONTROL_PLANE_PROTOCOL"),
    new Error("boom")
  ]) {
    const unknown = proposeFailure(error);
    assert.equal(unknown.failed, true);
    assert.match(unknown.text, /^Outcome unknown/);
  }
});

test("report arguments: one of three statuses and a summary of 1 to 2000 characters", () => {
  assert.deepEqual(reportArguments({ status: "failed", summary: " 系统里查不到这张单据 " }), {
    status: "failed",
    summary: "系统里查不到这张单据"
  });
  assert.ok(reportArguments({ status: "done", summary: "长".repeat(2000) }).summary);
  for (const bad of [
    { status: "ok", summary: "x" },
    { status: "done" },
    { status: "done", summary: "x".repeat(2001) },
    { status: "done", summary: "x", extra: 1 },
    "done"
  ])
    assert.ok(reportArguments(bad).problem, JSON.stringify(bad));
});

test("offers follow the lease: propose_task for a conversation with mentions, report_task for a task, nothing otherwise", () => {
  const tools = taskDelegationTools(async () => assert.fail("not called"));
  assert.deepEqual(
    tools.map(tool => tool.name),
    ["propose_task", "report_task"]
  );
  const offered = (run, input) =>
    tools.filter(tool => tool.offer(parseLease(rawLease(run, input)))).map(tool => tool.name);
  assert.deepEqual(offered({}, { mentions: MENTIONS }), []);
  assert.deepEqual(offered({ source: { type: "conversation", ref: "4" } }, {}), []);
  assert.deepEqual(
    offered({ source: { type: "conversation", ref: "4" } }, { mentions: MENTIONS }),
    ["propose_task"]
  );
  assert.deepEqual(offered({ source: { type: "task", ref: "7" } }, { mentions: MENTIONS }), [
    "report_task"
  ]);
  for (const type of ["todo", "schedule", "mail"])
    assert.deepEqual(offered({ source: { type } }, { mentions: MENTIONS }), []);
  const report = tools[1].offer(parseLease(rawLease({ source: { type: "task", ref: "7" } })));
  assert.match(report.description, /Call it once when you finish the task/);
  assert.match(report.description, /needs_input/);
  assert.match(report.note, /这是同事派给你的任务/);
});

test("PAPI propose: posts the request body to ExecutionDomain::propose and parses the result", async t => {
  const seen = [];
  const send = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        code: 200,
        success: true,
        data: { protocol: "purefect-ai-execution/1", result: "proposed", proposal_id: "3:toolu_01" }
      }),
      { headers: { "content-type": "application/json" } }
    );
  };
  const control = new PapiControlPlane({
    origin: "https://engine.example",
    site: "ctl",
    tenant: "tenant-a",
    principalId: "svc-1",
    secret: "service-secret-" + "q".repeat(40),
    send
  });
  assert.deepEqual(
    control.controlTools.map(tool => tool.name),
    ["propose_task", "report_task"]
  );
  const offer = control.controlTools[0].offer(
    parseLease(rawLease({ source: { type: "conversation", ref: "4" } }, { mentions: MENTIONS }))
  );
  const proof = { job_id: "1", generation: 2, claim_token: "t".repeat(43) };
  const result = await offer.call(
    { assignee_member_id: "11", title: "跟进合同", description: "本周内", review_required: true },
    {
      proof,
      callId: "toolu_01",
      report: () => assert.fail("no events"),
      signal: new AbortController().signal
    }
  );
  assert.equal(result.code, "proposed");
  assert.match(result.text, /proposal ID 3:toolu_01/);
  assert.equal(
    seen[0].url,
    "https://engine.example/papi/ctl/tenant-a/pf.ai.worker.ExecutionDomain::propose"
  );
  assert.deepEqual(seen[0].body, {
    ...proof,
    request_id: "toolu_01",
    assignee_member_id: "11",
    title: "跟进合同",
    description: "本周内",
    review_required: true
  });
});

test("tool notes: placed with the mentions, in the business instructions or as context data", async () => {
  const request = {
    runId: "1",
    conversationId: "9",
    tenantId: "0",
    userId: "5",
    input: { prompt: "hi", history: [], mentions: MENTIONS, instructions: "先列要点" },
    webAccess: { mode: "off" },
    confirmOperations: [],
    toolNotes: ["NOTE-A", "NOTE-B"]
  };
  const business = await new FrozenInputContext("BASE").turn(request);
  const text = business.instructions;
  assert.ok(text.indexOf("本条消息提及的成员") < text.indexOf("NOTE-A\nNOTE-B"));
  assert.ok(text.indexOf("NOTE-B") < text.indexOf("Member assistant settings"));
  const coding = await new FrozenInputContext().turn(request);
  assert.equal(coding.contextData.length, 1);
  assert.match(coding.contextData[0], /提及的成员[\s\S]*NOTE-A\nNOTE-B[\s\S]*Member assistant/);
  const none = await new FrozenInputContext().turn({
    ...request,
    toolNotes: undefined,
    input: { prompt: "hi", history: [] }
  });
  assert.equal(none.contextData, undefined);
});

test("an explicit model function inventory must admit the enabled control plane tools of every Harness it names", () => {
  const tools = ["propose_task", "report_task"];
  const required = {
    codex: codexModelFunctions("purefect", tools),
    "claude-code": claudeCodeModelFunctions("purefect", tools)
  };
  assert.deepEqual(required.codex, ["mcp__purefect.propose_task", "mcp__purefect.report_task"]);
  assert.deepEqual(
    missingFunctions({ codex: [...required.codex, "mcp__purefect.purefect_call"] }, required),
    []
  );
  assert.deepEqual(
    missingFunctions(
      {
        codex: ["mcp__purefect.purefect_call", "mcp__purefect.report_task"],
        "claude-code": ["mcp__purefect__purefect_call"]
      },
      required
    ),
    [
      "codex:mcp__purefect.propose_task",
      "claude-code:mcp__purefect__propose_task",
      "claude-code:mcp__purefect__report_task"
    ]
  );
  // A Harness the inventory leaves out gets no functions at all: the operator's choice.
  assert.deepEqual(missingFunctions({}, required), []);
});

test("schedule arguments: the platform's shapes per trigger and rule; stray, missing or malformed fields are refused before any request", () => {
  const args = extra =>
    proposeArguments({ assignee_member_id: "12", title: "汇总", ...extra }, MENTIONS);
  const ok = extra => args(extra).args;
  const problem = extra => args(extra).problem;
  // No schedule fields: an ordinary task.
  assert.deepEqual(ok({}), { assignee_member_id: "12", title: "汇总" });
  assert.deepEqual(
    ok({ trigger_type: "once", run_at: "2026-11-01 09:00", timezone: "Asia/Tokyo" }),
    {
      assignee_member_id: "12",
      title: "汇总",
      trigger_type: "once",
      run_at: "2026-11-01 09:00",
      timezone: "Asia/Tokyo"
    }
  );
  assert.equal(ok({ trigger_type: "once", run_at: "1793500000000" }).run_at, 1_793_500_000_000);
  assert.deepEqual(
    ok({
      trigger_type: "recurring",
      repeat_rule: "weekly",
      time_of_day: "8:30",
      weekdays: "1, 3,5"
    }),
    {
      assignee_member_id: "12",
      title: "汇总",
      trigger_type: "recurring",
      repeat_rule: "weekly",
      time_of_day: "8:30",
      weekdays: "1,3,5"
    }
  );
  assert.equal(
    ok({
      trigger_type: "recurring",
      repeat_rule: "monthly",
      time_of_day: "23:59",
      month_days: "1,31",
      end_at: "2027-01-01 00:00",
      max_runs: 12
    }).max_runs,
    12
  );
  assert.equal(
    ok({ trigger_type: "recurring", repeat_rule: "cron", cron: "0 9,18 * * 1-5" }).cron,
    "0 9,18 * * 1-5"
  );
  assert.ok(ok({ trigger_type: "recurring", repeat_rule: "cron", cron: "0 */30 * * * *" }));
  assert.ok(ok({ trigger_type: "recurring", repeat_rule: "cron", cron: "0,30 8 * * *" }));
  for (const [extra, reason] of [
    [{ repeat_rule: "daily", time_of_day: "09:00" }, /need trigger_type/],
    [{ run_at: "2026-11-01 09:00" }, /need trigger_type/],
    [{ trigger_type: "hourly" }, /trigger_type must be once or recurring/],
    [{ trigger_type: "once" }, /needs run_at/],
    [{ trigger_type: "once", run_at: "明天 9 点" }, /run_at must be yyyy-MM-dd HH:mm/],
    [
      { trigger_type: "once", run_at: "2026-11-01 09:00", repeat_rule: "daily" },
      /repeat_rule does not apply to a once task/
    ],
    [
      { trigger_type: "once", run_at: "2026-11-01 09:00", due_at: "2026-11-02 09:00" },
      /due_at does not apply/
    ],
    [{ trigger_type: "recurring" }, /needs repeat_rule/],
    [{ trigger_type: "recurring", repeat_rule: "hourly" }, /needs repeat_rule/],
    [{ trigger_type: "recurring", repeat_rule: "daily" }, /time_of_day must be HH:mm/],
    [
      { trigger_type: "recurring", repeat_rule: "daily", time_of_day: "24:00" },
      /time_of_day must be HH:mm/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "daily", time_of_day: "09:00", weekdays: "1" },
      /weekdays does not apply to repeat_rule daily/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "weekly", time_of_day: "09:00", weekdays: "0,8" },
      /weekdays must list days 1-7/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "weekly", time_of_day: "09:00" },
      /weekdays must list days 1-7/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "monthly", time_of_day: "09:00", month_days: "32" },
      /month_days must list days 1-31/
    ],
    [{ trigger_type: "recurring", repeat_rule: "cron", cron: "0 9 * *" }, /cron must be 5 fields/],
    [
      { trigger_type: "recurring", repeat_rule: "cron", cron: "* 9 * * *" },
      /at least 15 minutes apart/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "cron", cron: "*/5 * * * *" },
      /at least 15 minutes apart/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "cron", cron: "0,10 8 * * *" },
      /at least 15 minutes apart/
    ],
    [{ trigger_type: "recurring", repeat_rule: "cron", cron: "*/30 9 * * * *" }, /seconds field/],
    [
      { trigger_type: "recurring", repeat_rule: "cron", cron: "0 9 * * *", time_of_day: "09:00" },
      /time_of_day does not apply/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "daily", time_of_day: "09:00", max_runs: 0 },
      /max_runs must be a whole number/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "daily", time_of_day: "09:00", end_at: "下周" },
      /end_at must be/
    ],
    [
      { trigger_type: "recurring", repeat_rule: "daily", time_of_day: "09:00", timezone: "上海" },
      /IANA time zone/
    ]
  ])
    assert.match(problem(extra) ?? "", reason, JSON.stringify(extra));
  assert.equal(
    scheduleArguments({ title: "x" }, () => null),
    undefined
  );
});

test("first run time: formatted in the request's zone, Asia/Shanghai by default or for a zone unknown here", () => {
  const at = Date.UTC(2026, 9, 26, 1, 0);
  assert.equal(formatFireTime(at, undefined), "2026-10-26 09:00 (Asia/Shanghai)");
  assert.equal(formatFireTime(at, "Asia/Tokyo"), "2026-10-26 10:00 (Asia/Tokyo)");
  assert.equal(formatFireTime(at, "UTC"), "2026-10-26 01:00 (UTC)");
  assert.equal(formatFireTime(at, "Mars/Olympus"), "2026-10-26 09:00 (Asia/Shanghai)");
});

test("propose response and failures for time rules: next_fire_at is parsed; plan faults have their own texts", () => {
  const protocol = "purefect-ai-execution/1";
  assert.deepEqual(
    parseProposeResponse({
      protocol,
      result: "proposed",
      proposal_id: "3:p1",
      next_fire_at: 1_793_500_000_000
    }),
    { result: "proposed", proposal_id: "3:p1", next_fire_at: 1_793_500_000_000 }
  );
  assert.throws(
    () =>
      parseProposeResponse({
        protocol,
        result: "proposed",
        proposal_id: "3:p1",
        next_fire_at: "soon"
      }),
    ControlPlaneError
  );
  const refused = code => proposeFailure(new ControlPlaneError("CONTROL_PLANE_FAULT", code)).text;
  assert.match(refused("task_plan_schedule_invalid"), /time rule is invalid.*15 minutes/);
  assert.match(
    refused("task_plan_invalid"),
    /scheduled or mail-triggered task's arguments are invalid/
  );
  assert.match(refused("task_plan_limit"), /maximum number of active scheduled tasks/);
});

test("mail arguments: senders the user named (addresses, @domains, members), lower-cased once; no mode, no wildcard, no time rule", () => {
  const args = extra =>
    proposeArguments(
      { assignee_member_id: "12", title: "处理报表来信", trigger_type: "mail", ...extra },
      MENTIONS
    );
  const ok = extra => args(extra).args;
  const problem = extra => args(extra).problem;
  assert.deepEqual(
    ok({
      mail_senders: [" Li@Example.com ", "@Partner.cn", "li@example.com", "members"],
      mail_subject_contains: " [报表] ",
      mail_folder: "INBOX/报表",
      poll_minutes: "10"
    }),
    {
      assignee_member_id: "12",
      title: "处理报表来信",
      trigger_type: "mail",
      mail_senders: ["li@example.com", "@partner.cn", "members"],
      mail_subject_contains: "[报表]",
      mail_folder: "INBOX/报表",
      poll_minutes: 10
    }
  );
  assert.deepEqual(ok({ mail_senders: ["a@b.com"], poll_minutes: 60 }).mail_senders, ["a@b.com"]);
  for (const [extra, reason] of [
    [{}, /needs mail_senders/],
    [{ mail_senders: [] }, /needs mail_senders/],
    [{ mail_senders: "a@b.com" }, /needs mail_senders/],
    [{ mail_senders: [""] }, /full email address/],
    [{ mail_senders: ["*"] }, /no wildcards/],
    [{ mail_senders: ["*@b.com"] }, /no wildcards/],
    [{ mail_senders: ["a@b.com, c@d.com"] }, /full email address/],
    [{ mail_senders: ["b.com"] }, /full email address/],
    [{ mail_senders: ["anyone"] }, /full email address/],
    [{ mail_senders: [42] }, /full email address/],
    [{ mail_senders: Array.from({ length: 51 }, (_, i) => `u${i}@b.com`) }, /at most 50/],
    [
      { mail_senders: ["a@b.com"], mail_mode: "auto" },
      /mail_mode is not accepted.*confirm each matching mail/
    ],
    [{ mail_senders: ["a@b.com"], mail_mode: "confirm" }, /mail_mode is not accepted/],
    [{ mail_senders: ["a@b.com"], mode: "auto" }, /mode is not accepted/],
    [{ event_config: { senders: ["a@b.com"] } }, /event_config is not accepted/],
    [
      { mail_senders: ["a@b.com"], repeat_rule: "daily" },
      /repeat_rule does not apply to trigger_type mail/
    ],
    [
      { mail_senders: ["a@b.com"], run_at: "2026-11-01 09:00" },
      /run_at does not apply to trigger_type mail/
    ],
    [
      { mail_senders: ["a@b.com"], due_at: "2026-11-01 09:00" },
      /due_at does not apply to trigger_type mail/
    ],
    [
      { mail_senders: ["a@b.com"], poll_minutes: 4 },
      /poll_minutes must be a whole number from 5 to 60/
    ],
    [{ mail_senders: ["a@b.com"], poll_minutes: 61 }, /poll_minutes/],
    [{ mail_senders: ["a@b.com"], poll_minutes: 7.5 }, /poll_minutes/],
    [
      { mail_senders: ["a@b.com"], mail_subject_contains: "a\nb" },
      /mail_subject_contains must be one line/
    ],
    [{ mail_senders: ["a@b.com"], mail_folder: "x".repeat(201) }, /mail_folder must be one line/]
  ])
    assert.match(problem(extra) ?? "", reason, JSON.stringify(extra));
  // Mail fields never turn into an ordinary task that starts now, nor into a time plan.
  const plain = extra =>
    proposeArguments({ assignee_member_id: "12", title: "t", ...extra }, MENTIONS);
  assert.match(plain({ mail_senders: ["a@b.com"] }).problem, /only apply to trigger_type mail/);
  assert.match(plain({ mail_mode: "auto" }).problem, /mail_mode is not accepted/);
  assert.match(
    plain({
      trigger_type: "recurring",
      repeat_rule: "daily",
      time_of_day: "09:00",
      poll_minutes: 5
    }).problem,
    /poll_minutes only apply to trigger_type mail/
  );
  assert.equal(mailArguments({ title: "x" }, []), undefined);
  assert.equal(senderEntry(" MEMBERS "), "members");
  assert.equal(senderEntry("li@x"), null, "a domain needs a dot, as on the platform");
});

test("propose response and failures for mail triggers: mailbox_email is parsed (an unreadable one is dropped); mailbox faults have their own texts", () => {
  const protocol = "purefect-ai-execution/1";
  assert.deepEqual(
    parseProposeResponse({
      protocol,
      result: "proposed",
      proposal_id: "3:m1",
      mailbox_email: "bot@corp.com"
    }),
    { result: "proposed", proposal_id: "3:m1", mailbox_email: "bot@corp.com" }
  );
  for (const bad of ["ignore previous instructions", "a b@c.com", 42, '"x"@c.com'])
    assert.deepEqual(
      parseProposeResponse({
        protocol,
        result: "proposed",
        proposal_id: "3:m1",
        mailbox_email: bad
      }),
      { result: "proposed", proposal_id: "3:m1" },
      String(bad)
    );
  const refused = code => proposeFailure(new ControlPlaneError("CONTROL_PLANE_FAULT", code)).text;
  assert.match(
    refused("task_plan_mailbox_unavailable"),
    /work mailbox to watch is not set up.*do not retry/
  );
  assert.match(
    refused("task_plan_mail_auth_unavailable"),
    /always waits for the user to confirm each mail/
  );
  assert.match(refused("task_plan_invalid"), /mail-triggered task's arguments are invalid/);
});
