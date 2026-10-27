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
import { ResponsesProvider } from "../dist/gateway/model/responses-provider.js";
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";

const secret = "private-provider-key-12345";
const request = parseResponsesRequest({ model: "alias", input: "hello", stream: true }, [], 100);
const terminal = () => ({
  type: "response.completed",
  sequence_number: 0,
  response: {
    id: "resp_test",
    model: "authorized-model",
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5 }
  }
});
const reply = events =>
  new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
const signal = () => new AbortController().signal;

test("provider function calls must match the exact approved namespace pair", async () => {
  const managed = parseResponsesRequest(
    {
      model: "alias",
      stream: true,
      input: "read",
      tools: [
        {
          type: "namespace",
          name: "mcp__purefect",
          tools: [{ type: "function", name: "read", parameters: {} }]
        }
      ]
    },
    ["mcp__purefect.read"],
    100
  );
  for (const namespace of ["mcp__purefect", "foreign", undefined]) {
    const end = terminal();
    end.response.output = [
      { type: "function_call", name: "read", namespace, call_id: "c", arguments: "{}" }
    ];
    const provider = new ResponsesProvider("https://approved.example", async () => reply([end]));
    const result = provider.invoke(managed, "authorized-model", secret, [], signal());
    if (namespace === "mcp__purefect") await result;
    else await assert.rejects(result, { message: "MODEL_RESPONSES_PROVIDER_UNAVAILABLE" });
  }
});

test("Responses provider uses only pinned endpoint and authority-selected model", async () => {
  let calls = 0;
  const provider = new ResponsesProvider("https://approved.example", async (url, options) => {
    calls++;
    assert.equal(url, "https://approved.example/v1/responses");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "authorized-model");
    assert.equal(body.store, false);
    return reply([terminal()]);
  });
  const result = await provider.invoke(request, "authorized-model", secret, [], signal());
  assert.equal(calls, 1);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

for (const fault of [
  "wrong-model",
  "missing-usage",
  "provider-failure",
  "credential",
  "truncated"
]) {
  test(`Responses provider rejects ${fault} without retries or raw diagnostics`, async () => {
    let calls = 0;
    const event = terminal();
    if (fault === "wrong-model") event.response.model = "other";
    if (fault === "missing-usage") delete event.response.usage;
    if (fault === "credential") event.response.output.push({ text: secret });
    if (fault === "truncated") event.type = "response.created";
    const provider = new ResponsesProvider("https://approved.example", async () => {
      calls++;
      if (fault === "provider-failure") throw Error(secret);
      return reply([event]);
    });
    await assert.rejects(provider.invoke(request, "authorized-model", secret, [], signal()), {
      message: "MODEL_RESPONSES_PROVIDER_UNAVAILABLE"
    });
    assert.equal(calls, 1);
  });
}

test("Responses provider rejects a credential split across text deltas before returning output", async () => {
  const end = terminal();
  end.sequence_number = 2;
  const provider = new ResponsesProvider("https://approved.example", async () =>
    reply([
      { type: "response.output_text.delta", sequence_number: 0, delta: secret.slice(0, 10) },
      { type: "response.output_text.delta", sequence_number: 1, delta: secret.slice(10) },
      end
    ])
  );
  await assert.rejects(provider.invoke(request, "authorized-model", secret, [], signal()), {
    message: "MODEL_RESPONSES_PROVIDER_UNAVAILABLE"
  });
});

test("Responses provider rejects provider tools in intermediate events even with a clean final response", async () => {
  const end = terminal();
  end.sequence_number = 1;
  const provider = new ResponsesProvider("https://approved.example", async () =>
    reply([
      { type: "response.output_item.added", sequence_number: 0, item: { type: "web_search_call" } },
      end
    ])
  );
  await assert.rejects(provider.invoke(request, "authorized-model", secret, [], signal()), {
    message: "MODEL_RESPONSES_PROVIDER_UNAVAILABLE"
  });
});

test("relay metadata events are dropped, not forwarded and not treated as failures", async () => {
  const published = [];
  const metadata = {
    type: "response.metadata",
    sequence_number: 0,
    response_id: "resp_test",
    metadata: { route: "relay" }
  };
  const provider = new ResponsesProvider("https://approved.example", async () =>
    reply([metadata, { ...terminal(), sequence_number: 1 }])
  );
  const result = await provider.invoke(
    request,
    "authorized-model",
    secret,
    [],
    signal(),
    async e => {
      published.push(e.type);
    }
  );
  assert.ok(result.events.every(e => e.type !== "response.metadata"));
  assert.ok(!published.includes("response.metadata"));
});
