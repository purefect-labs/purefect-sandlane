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
import { upstreamEndpoint } from "../dist/gateway/model/upstream-endpoint.js";
import { probeModel } from "../scripts/model-compatibility-lib.js";

const cases = [
  [
    "deepseek-codex",
    "responses",
    "https://api.deepseek.com/responses",
    "https://api.deepseek.com/responses"
  ],
  [
    "deepseek-claude",
    "anthropic-messages",
    "https://api.deepseek.com/anthropic",
    "https://api.deepseek.com/anthropic/v1/messages"
  ],
  [
    "glm-codex",
    "responses",
    "https://open.bigmodel.cn/api/v1",
    "https://open.bigmodel.cn/api/v1/responses"
  ],
  [
    "glm-claude",
    "anthropic-messages",
    "https://open.bigmodel.cn/api/anthropic",
    "https://open.bigmodel.cn/api/anthropic/v1/messages"
  ],
  [
    "qwen-codex",
    "responses",
    "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses"
  ],
  [
    "qwen-claude",
    "anthropic-messages",
    "https://workspace.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    "https://workspace.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
  ]
];

test("legacy roots and versioned bases retain their endpoints", () => {
  for (const wire of ["responses", "anthropic-messages"]) {
    const resource = wire === "responses" ? "responses" : "messages";
    for (const suffix of ["", "/", "/v1", "/v1/"])
      assert.equal(
        upstreamEndpoint("https://provider.example" + suffix, wire),
        "https://provider.example/v1/" + resource
      );
    assert.equal(
      upstreamEndpoint("https://provider.example:9443/prefix/v2/" + resource, wire),
      "https://provider.example:9443/prefix/v2/" + resource
    );
  }
});

test("ambiguous or credential-bearing endpoints fail without reflecting configuration", () => {
  for (const path of [
    "http://example.test/v1",
    "https://user:secret@example.test/v1",
    "https://example.test/v1?key=secret",
    "https://example.test/v1#secret",
    "https://example.test/v1?",
    "https://example.test/v1#",
    "https://example.test/api/../v1",
    "https://example.test/api/./v1",
    "https://example.test/%2e%2e/v1",
    "https://example.test/api//v1",
    "https://example.test/v1/chat/completions",
    " https://example.test",
    "https://example.test/\\\\evil"
  ])
    for (const wire of ["responses", "anthropic-messages"])
      assert.throws(() => upstreamEndpoint(path, wire), {
        message: "MODEL_PROVIDER_CONFIGURATION"
      });
  assert.throws(() => upstreamEndpoint("https://example.test/v1/messages", "responses"));
  assert.throws(() => upstreamEndpoint("https://example.test/v1/responses", "anthropic-messages"));
});

const secret = "test-key-" + "k".repeat(40);
const sse = events =>
  new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" }
  });

// Synthetic protocol fixtures, NOT captured vendor responses or a live compatibility claim.
for (const [id, wire, baseUri, endpoint] of cases) {
  test(id + ": endpoint, credentials, streamed tool/result roundtrip and usage", async () => {
    assert.equal(upstreamEndpoint(baseUri, wire), endpoint);
    assert.equal(upstreamEndpoint(baseUri + "/", wire), endpoint);
    let calls = 0,
      nonce;
    const result = await probeModel(
      { wire, baseUri, model: "test-model", auth: "bearer" },
      secret,
      async (url, options) => {
        assert.equal(url, endpoint);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.authorization, "Bearer " + secret);
        assert.ok(!options.headers["x-api-key"]);
        assert.equal(options.signal.aborted, false);
        const body = JSON.parse(options.body);
        assert.equal(body.model, "test-model");
        assert.equal(body.stream, true);
        assert.ok(!options.body.includes(secret));
        const first = calls++ === 0;
        if (first)
          nonce = (wire === "responses" ? body.input : body.messages[0].content).match(
            /value ([a-f0-9]{24})/
          )[1];
        else
          assert.ok(
            JSON.stringify(
              wire === "responses" ? body.input.at(-1) : body.messages.at(-1)
            ).includes(nonce)
          );
        if (wire === "responses") {
          assert.equal(body.store, false);
          const output = first
            ? [
                {
                  type: "function_call",
                  name: "compatibility_echo",
                  call_id: "call_1",
                  arguments: JSON.stringify({ value: nonce })
                }
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: nonce }]
                }
              ];
          return sse([
            ...(!first
              ? [{ type: "response.output_text.delta", sequence_number: 0, delta: nonce }]
              : []),
            {
              type: "response.completed",
              sequence_number: first ? 0 : 1,
              response: {
                id: "resp_1",
                model: "test-model",
                status: "completed",
                output,
                usage: { input_tokens: 10, output_tokens: 5 }
              }
            }
          ]); // Deliberately no [DONE], as documented by GLM.
        }
        return sse([
          {
            type: "message_start",
            message: {
              id: "msg_1",
              role: "assistant",
              model: "test-model",
              content: [],
              usage: { input_tokens: 10 }
            }
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: first
              ? { type: "tool_use", id: "tool_1", name: "compatibility_echo", input: {} }
              : { type: "text", text: "" }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: first
              ? { type: "input_json_delta", partial_json: JSON.stringify({ value: nonce }) }
              : { type: "text_delta", text: nonce }
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: first ? "tool_use" : "end_turn" },
            usage: { output_tokens: 5 }
          },
          { type: "message_stop" }
        ]);
      }
    );
    assert.equal(calls, 2);
    assert.deepEqual(result, { requests: 2, toolCalls: 1, inputTokens: 20, outputTokens: 10 });
  });
}

test("live probe reports provider failures without retrying or claiming success", async () => {
  for (const wire of ["responses", "anthropic-messages"]) {
    let calls = 0;
    await assert.rejects(
      probeModel({ wire, baseUri: "https://provider.example", model: "test" }, secret, async () => {
        calls++;
        return new Response('{"error":{"message":"denied"}}', { status: 401 });
      })
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    probeModel(
      { wire: "chat-completions", baseUri: "https://provider.example", model: "test" },
      secret
    ),
    /INVALID_PROBE_PROFILE/
  );
});
