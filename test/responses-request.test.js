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
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";

const input = () => ({
  model: "analysis",
  stream: true,
  input: [{ role: "user", content: "你好" }],
  tools: [
    {
      type: "function",
      name: "mcp__purefect__read",
      parameters: { type: "object", properties: {} }
    }
  ]
});
const parse = value => parseResponsesRequest(value, ["mcp__purefect__read"], 4096);

const native = () => ({
  model: "analysis",
  stream: true,
  input: [{ role: "user", content: "read" }],
  prompt_cache_key: "client-thread-id",
  client_metadata: { source: "cli" },
  tools: [
    { type: "function", name: "request_user_input", parameters: {} },
    {
      type: "namespace",
      name: "mcp__purefect",
      tools: [{ type: "function", name: "metadata_read", parameters: { type: "object" } }]
    }
  ]
});
const parseNative = request => parseResponsesRequest(request, ["mcp__purefect.metadata_read"], 100);

test("native MCP namespace preserves identity while local helpers and cache hints stay off-provider", () => {
  const source = native();
  source.input.push(
    {
      type: "function_call",
      namespace: "mcp__purefect",
      name: "metadata_read",
      call_id: "c1",
      arguments: "{}"
    },
    {
      type: "function_call_output",
      call_id: "c1",
      output: [{ type: "input_text", text: "result" }]
    }
  );
  const result = parseNative(source);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "mcp__purefect");
  assert.ok(!("prompt_cache_key" in result));
  assert.ok(!("client_metadata" in result));
  assert.equal(source.tools.length, 2);
  assert.equal(result.input[1].namespace, "mcp__purefect");
});

test("native compatibility never enables foreign namespaces, local calls or non-text outputs", () => {
  for (const mutate of [
    r => {
      r.tools[1].name = "foreign";
    },
    r => {
      r.tools.push(structuredClone(r.tools[1]));
    },
    r => {
      r.tools[1].tools[0].name = "write";
    },
    r => {
      r.tools.push({ type: "function", name: "exec_command", parameters: {} });
    },
    r => {
      r.tools.push({ type: "code_interpreter", container: { type: "auto" } });
    },
    r => {
      r.input.push({
        type: "function_call",
        name: "request_user_input",
        call_id: "c",
        arguments: "{}"
      });
    },
    r => {
      r.input.push({
        type: "function_call",
        namespace: "foreign",
        name: "metadata_read",
        call_id: "c",
        arguments: "{}"
      });
    },
    r => {
      r.input.push({
        type: "function_call_output",
        call_id: "c",
        output: [{ type: "input_image", image_url: "https://foreign" }]
      });
    },
    r => {
      r.client_metadata = { nested: { token: "not allowed" } };
    }
  ]) {
    const request = native();
    mutate(request);
    assert.throws(() => parseNative(request), { message: "MODEL_RESPONSES_REQUEST_INVALID" });
  }
});

test("managed Responses request snapshots a stateless tool request and bounded token reservation", () => {
  const source = input();
  const parsed = parse(source);
  source.input[0].content = "changed";
  assert.equal(parsed.input[0].content, "你好");
  assert.equal(parsed.store, false);
  assert.equal(parsed.max_output_tokens, 4096);
  assert.ok(Object.isFrozen(parsed.tools[0].parameters));
});

for (const [name, patch] of [
  ["shared provider conversation", { previous_response_id: "resp_foreign" }],
  ["conversation object", { conversation: "foreign" }],
  ["provider persistence", { store: true }],
  ["background execution", { background: true }],
  ["tenant identity", { tenantId: "other" }],
  ["remote MCP", { tools: [{ type: "mcp", server_url: "https://foreign.example" }] }],
  ["provider file search", { tools: [{ type: "file_search", vector_store_ids: ["vs"] }] }],
  ["provider code interpreter", { tools: [{ type: "code_interpreter" }] }],
  [
    "provider web search history without web access",
    {
      input: [{ type: "web_search_call", id: "ws_1", status: "completed" }]
    }
  ],
  ["unapproved shell", { tools: [{ type: "function", name: "shell", parameters: {} }] }],
  ["stored item reference", { input: [{ type: "item_reference", id: "foreign" }] }],
  [
    "remote image",
    {
      input: [
        { role: "user", content: [{ type: "input_image", image_url: "https://foreign.example" }] }
      ]
    }
  ],
  ["excess tokens", { max_output_tokens: 4097 }],
  ["invalid unicode", { input: "\ud800" }]
]) {
  test(`managed Responses rejects ${name}`, () => {
    assert.throws(() => parse({ ...input(), ...patch }), {
      message: "MODEL_RESPONSES_REQUEST_INVALID"
    });
  });
}

test("managed Responses retains allowed function history and stateless encrypted reasoning", () => {
  const request = input();
  request.input.push(
    { type: "function_call", call_id: "call_1", name: "mcp__purefect__read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "{}" },
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] }
  );
  assert.equal(parse(request).input.length, 4);
});
