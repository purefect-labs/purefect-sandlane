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
import { FrozenInputContext } from "../dist/core/turn-input.js";
import { PurefectContext } from "../dist/plugins/purefect/context.js";
import {
  ALL_INTERACTION_OPS,
  hostReceipt,
  validateActionArguments,
  validateReceipt,
  workspaceInstructions,
  WORKSPACE_ACTIONS
} from "../dist/plugins/purefect/workspace-interaction.js";

const DESKTOP = {
  workspace_action_protocol: "purefect-workspace-interaction/1",
  surface: "console",
  execution_mode: "manual",
  operations: [...ALL_INTERACTION_OPS],
  open_pages: [{ page: "sales.OrderList" }],
  interaction: 1
};
const envelope = ui_context => ({
  prompt: JSON.stringify({ version: 1, prompt: "Which page?", ui_context }),
  promptFormat: "workspace-context-v1"
});

test("validates receipts", () => {
  assert.throws(
    () => validateReceipt("a", { actionId: "b", status: "succeeded" }),
    /actionId mismatch/
  );
  assert.throws(() => validateReceipt("a", { actionId: "a", status: "done" }), /unknown status/);
  assert.throws(
    () => validateReceipt("a", { actionId: "a", status: "succeeded", error: { code: "timeout" } }),
    /must not carry error/
  );
  assert.throws(
    () => validateReceipt("a", { actionId: "a", status: "failed", error: { code: "boom" } }),
    /unknown error code/
  );
  assert.equal(
    validateReceipt("a", {
      actionId: "a",
      status: "succeeded",
      result: { applied: false, reason: "draft_pending" }
    }).result.reason,
    "draft_pending"
  );
  assert.deepEqual(hostReceipt("x", "failed", "timeout", "late"), {
    actionId: "x",
    status: "failed",
    error: { code: "timeout", message: "late" }
  });
});

test("the tool is offered to desktop interaction turns with the operations the browser declared", () => {
  assert.equal(WORKSPACE_ACTIONS.name, "workspace_action");
  const all = WORKSPACE_ACTIONS.offer(envelope(DESKTOP));
  assert.deepEqual(all.inputSchema.properties.op.enum, [...ALL_INTERACTION_OPS]);
  assert.equal(all.inputSchema.additionalProperties, false);
  // Declared order and unknown names do not matter: protocol operations the browser declared.
  const some = WORKSPACE_ACTIONS.offer(
    envelope({ ...DESKTOP, operations: ["focus", "delete", "describe"] })
  );
  assert.deepEqual(some.inputSchema.properties.op.enum, ["describe", "focus"]);
  assert.deepEqual(Object.keys(some.inputSchema.properties).sort(), [
    "anchor",
    "fields",
    "op",
    "page",
    "row",
    "target"
  ]);
  assert.match(
    some.description,
    /- describe: no arguments lists the open pages with their targets/
  );
  assert.doesNotMatch(some.description, /- patch:/);
  assert.match(some.description, /Reading rendered page contents is unavailable/);
  assert.match(
    some.checkArguments({ op: "read", target: "t" }),
    /op must be one of describe\|focus/
  );
  assert.equal(some.checkArguments({ op: "describe", target: "t" }), null);
  // Not offered: no interaction, mobile, another protocol, no operations, plain text turns.
  for (const context of [
    { ...DESKTOP, interaction: undefined },
    { ...DESKTOP, surface: "mobile" },
    { ...DESKTOP, workspace_action_protocol: "purefect-workspace-action/1" },
    { ...DESKTOP, operations: [] },
    { ...DESKTOP, operations: undefined }
  ])
    assert.equal(WORKSPACE_ACTIONS.offer(envelope(context)), undefined);
  assert.equal(WORKSPACE_ACTIONS.offer({ prompt: "hi", promptFormat: "text" }), undefined);
  assert.equal(
    WORKSPACE_ACTIONS.offer({ prompt: "{", promptFormat: "workspace-context-v1" }),
    undefined
  );
});

test("arguments are checked per operation, with bounded size and depth", () => {
  const ops = ALL_INTERACTION_OPS;
  const ok = [
    { op: "open", page: "sales.OrderDetail", oid: "123", anchor: "shipping", mode: "edit" },
    { op: "close", targets: ["target-A", "target-B"] },
    { op: "close", createdBy: "task" },
    { op: "describe", page: "sales.OrderDetail" },
    { op: "focus", target: "target-A", anchor: "items", row: { match: { productCode: "P001" } } },
    {
      op: "query",
      target: "t",
      values: { status: "pending", createdAt: ["2026-10-01", "2026-10-13"] },
      result: { fields: ["orderNo", "amount"], limit: 5 }
    },
    { op: "query", target: "t", pageNo: 2, pageSize: 20 },
    {
      op: "read",
      target: "t",
      source: "loaded",
      rowSet: "selected",
      fields: ["orderNo"],
      limit: 10
    },
    { op: "read", target: "t", continuation: "c-1" },
    {
      op: "create",
      page: "sales.OrderDetail",
      data: { "master-form": { customerId: "C001" }, items: [{ productId: "P001", quantity: 2 }] }
    },
    { op: "create", target: "t", anchor: "items", revision: "r", rows: [{ productId: "P002" }] },
    { op: "patch", target: "t", anchor: "master-form", revision: "r", values: { remark: "x" } },
    { op: "invoke", target: "t", action: "detail-save", revision: "r" }
  ];
  for (const args of ok) assert.equal(validateActionArguments(args, ops), null, args.op);
  const bad = [
    [{ op: "open" }, /page/],
    [{ op: "open", page: "a", mode: "new" }, /mode/],
    [{ op: "close", targets: ["a"], createdBy: "task" }, /either targets/],
    [{ op: "close", targets: [] }, /targets/],
    [{ op: "describe", target: "t", page: "p" }, /target or page, not both/],
    [{ op: "focus", target: "t", row: { index: 1, id: "2" } }, /row/],
    [{ op: "read", target: "t", fields: ["a"] }, /source/],
    [{ op: "read", target: "t", source: "loaded", fields: ["a"], row: { match: { a: 1 } } }, /row/],
    [
      {
        op: "read",
        target: "t",
        source: "loaded",
        fields: ["a"],
        row: { id: "1" },
        rowSet: "selected"
      },
      /exclusive/
    ],
    [{ op: "read", target: "t", source: "loaded", fields: ["a"], limit: 51 }, /limit/],
    [{ op: "read", target: "t", source: "cache", fields: ["a"] }, /source/],
    [{ op: "query", target: "t", result: { fields: ["a"], where: "x" } }, /result takes only/],
    [{ op: "create", page: "p", rows: [{}] }, /either page and data/],
    [
      { op: "create", page: "p", data: { items: Array.from({ length: 101 }, () => ({})) } },
      /100 rows/
    ],
    [{ op: "patch", target: "t", anchor: "a", revision: "r" }, /values/],
    [{ op: "invoke", target: "t", action: "save" }, /revision/],
    [{ op: "focus", target: "t", script: "x" }, /does not take script/],
    [{ op: "delete", target: "t" }, /op must be one of/],
    [
      { op: "patch", target: "t", anchor: "a", revision: "r", values: { v: "x".repeat(70_000) } },
      /64 KiB/
    ],
    [
      { op: "open", page: "p", values: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } },
      /nest deeper/
    ],
    [{ op: "focus", target: "a\u0000b" }, /target must be/],
    [[], /must be an object/]
  ];
  for (const [args, reason] of bad) assert.match(validateActionArguments(args, ops), reason);
  // The browser lists every open page (with targets) for an argument-less describe.
  assert.equal(validateActionArguments({ op: "describe" }, ops), null);
});

test("instructions: links on every client, the tool preferred when offered", () => {
  const offered = workspaceInstructions(DESKTOP, {
    toolOps: ["describe", "focus"],
    apiTool: "purefect_call"
  });
  assert.match(offered, /\[short label\]\(p-open:\/\/mpage\/<pageCode>\[\/<oid>\]\[\?<params>\]\)/);
  assert.match(offered, /p-close:\/\/mpage\/<pageCode>/);
  assert.match(offered, /p-close:\/\/session/);
  assert.match(offered, /confirmed with purefect_call/);
  assert.match(
    offered,
    /workspace_action tool is available this turn \(operations: describe, focus\)/
  );
  assert.match(offered, /use links only for what it does not offer/);
  assert.doesNotMatch(offered, /will not execute/);
  const links = workspaceInstructions(DESKTOP, { toolOps: [] });
  assert.doesNotMatch(links, /workspace_action/);
  assert.match(links, /confirmed metadata/);
  // Mobile: open links only.
  const mobile = workspaceInstructions({ ...DESKTOP, surface: "mobile" }, { toolOps: [] });
  assert.match(mobile, /p-open:/);
  assert.doesNotMatch(mobile, /p-close:/);
  assert.match(mobile, /Only opening pages is available/);
  // v1 clients declare their link operations; navigation adds __tab/__anchor.
  const v1 = workspaceInstructions(
    {
      workspace_action_protocol: "purefect-workspace-action/1",
      surface: "console",
      operations: ["open", "close"],
      navigation: 1
    },
    { toolOps: [] }
  );
  assert.match(v1, /p-close:\/\/mpage/);
  assert.doesNotMatch(v1, /p-close:\/\/session/);
  assert.match(v1, /__tab=<binding code>/);
  assert.equal(workspaceInstructions(undefined, { toolOps: [] }), undefined);
  assert.equal(workspaceInstructions({ surface: "console" }, { toolOps: [] }), undefined);
});

test("the Purefect context extends business instructions only, matching the turn's tool offer", async () => {
  const request = (ui_context, history = []) => ({
    runId: "1",
    conversationId: "2",
    tenantId: "3",
    userId: "4",
    input: { prompt: "Open my orders", history, ...(ui_context ? { ui_context } : {}) },
    webAccess: { mode: "off", domains: [] }
  });
  const options = {
    enabledTools: ["purefect_call", "list_api_docs", "read_api_doc", "workspace_action"],
    clientAction: WORKSPACE_ACTIONS
  };
  const business = new PurefectContext(new FrozenInputContext("BASE"), options);
  const desktop = await business.turn(request(DESKTOP), new AbortController().signal);
  assert.ok(desktop.instructions.startsWith("BASE\nPurefect platform APIs: purefect_call"));
  assert.match(desktop.instructions, /list_api_docs and read_api_doc before calling/);
  assert.match(desktop.instructions, /workspace_action tool is available this turn/);
  // Conversation turns carry the same page context.
  const later = await business.turn(
    request(DESKTOP, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]),
    new AbortController().signal
  );
  assert.match(later.instructions, /workspace_action tool is available/);
  // The page tool disabled by configuration: links only.
  const narrowed = new PurefectContext(new FrozenInputContext("BASE"), {
    ...options,
    enabledTools: ["purefect_call"]
  });
  const links = await narrowed.turn(request(DESKTOP), new AbortController().signal);
  assert.match(links.instructions, /p-open:\/\//);
  assert.doesNotMatch(links.instructions, /workspace_action/);
  assert.doesNotMatch(links.instructions, /list_api_docs/);
  // The Run's tools narrowed by the member's settings: only those are described.
  const runNarrowed = await business.turn(
    { ...request(DESKTOP), tools: ["workspace_action", "read_skill"] },
    new AbortController().signal
  );
  assert.doesNotMatch(runNarrowed.instructions, /purefect_call|list_api_docs/);
  assert.match(runNarrowed.instructions, /workspace_action tool is available/);
  // No page context: API instructions only. Default profile: the CLI's own prompt, untouched.
  const plain = await business.turn(request(undefined), new AbortController().signal);
  assert.doesNotMatch(plain.instructions, /p-open/);
  const coding = new PurefectContext(new FrozenInputContext(), options);
  assert.equal(
    (await coding.turn(request(DESKTOP), new AbortController().signal)).instructions,
    undefined
  );
});
