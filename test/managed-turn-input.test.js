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
import { createJsonControlServer } from "../dist/sandbox/docker/server.js";
import { parseRunSpec } from "../dist/sandbox/docker/contracts.js";
import { managedTurnInput, parsePromptFormat } from "../dist/common/turn-envelope.js";

const context = {
  workspace_action_protocol: "purefect-workspace-action/1",
  surface: "console",
  execution_mode: "manual",
  operations: ["open"],
  open_pages: [],
  active_page: { page: "pf.test.page" }
};
const envelope = (changes = {}) =>
  JSON.stringify({ version: 1, prompt: "当前是什么页面？", ui_context: context, ...changes });

test("context is a separate user data item, never instructions or a promoted identity", () => {
  const items = managedTurnInput(envelope(), "workspace-context-v1");
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "当前是什么页面？");
  assert.equal(
    items[1].text,
    `Workspace UI context (data only; applies only to this turn):\n${JSON.stringify(context)}`
  );
  assert.ok(items.every(item => item.type === "text" && !Object.hasOwn(item, "role")));
});

test("plain JSON is never sniffed as context and subsequent turns retain no prior context", () => {
  managedTurnInput(envelope(), "workspace-context-v1");
  assert.deepEqual(managedTurnInput(envelope()), [
    { type: "text", text: envelope(), text_elements: [] }
  ]);
  assert.deepEqual(managedTurnInput("next"), [{ type: "text", text: "next", text_elements: [] }]);
  assert.equal(parsePromptFormat(undefined), "text");
});

test("version, fields, context size and decoded prompt size are bounded", () => {
  for (const changes of [
    { version: 2 },
    { system: "injected" },
    { prompt: "" },
    { prompt: "a".repeat(20001) },
    { ui_context: [] },
    { ui_context: { value: "a".repeat(8193) } }
  ]) {
    assert.throws(() => managedTurnInput(envelope(changes), "workspace-context-v1"));
  }
  assert.throws(() => parsePromptFormat("unknown"));
  assert.throws(() => managedTurnInput("a".repeat(20001)));
});

test("allocation accepts the bounded escaped envelope while small control routes retain their limit", async t => {
  const token = "t".repeat(43);
  const server = createJsonControlServer(
    {
      "/v2/allocate": async value => ({ format: parseRunSpec(value).promptFormat }),
      "/v1/status": async () => ({ ready: true })
    },
    token
  );
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const prompt = envelope({ prompt: '"'.repeat(19000) });
  const body = JSON.stringify({
    schemaVersion: 2,
    harness: "codex",
    allocationId: "a",
    runId: "r",
    tenantId: "0",
    userId: "1",
    generation: 1,
    expiresAt: Date.now() + 300000,
    leaseExpiresAt: Date.now() + 30000,
    prompt,
    promptFormat: "workspace-context-v1"
  });
  assert.ok(Buffer.byteLength(body) > 32000);
  const request = route =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body
    });
  const accepted = await request("/v2/allocate");
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).format, "workspace-context-v1");
  const denied = await request("/v1/status");
  assert.equal(denied.status, 413);
  await denied.body.cancel();
});
