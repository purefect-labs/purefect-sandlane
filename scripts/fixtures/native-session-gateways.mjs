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

/** Offline native-session probe: production model gateway, synthetic provider and MCP.
 * All identities, capabilities and content in this process are disposable fixture data.
 */
import assert from "node:assert/strict";
import https from "node:https";
import { createModelServer } from "../../dist/gateway/model/model-server.js";
import { ModelGateway } from "../../dist/gateway/model/gateway.js";
import { ResponsesProvider } from "../../dist/gateway/model/responses-provider.js";

const config = JSON.parse(process.env.FIXTURE);
const emit = value => console.log(JSON.stringify(value));
const owner = (token, field) => {
  const user = config.users.find(user => user[field] === token);
  assert.ok(user, "Unknown fixture capability");
  return user;
};
const tls = { key: config.key, cert: config.cert };
const calls = new Map();
const provider = new ResponsesProvider("https://fixture.invalid", async (_url, options) => {
  const body = JSON.parse(options.body);
  const user = owner(options.headers.authorization.slice(7), "model");
  emit({ kind: "upstream", run: user.id, body });
  const number = (calls.get(user.id) ?? 0) + 1;
  calls.set(user.id, number);
  const tool = user.id === "first" && number === 1;
  const item = tool
    ? {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        namespace: "mcp__fixture",
        name: "read",
        arguments: "{}",
        status: "completed"
      }
    : {
        type: "message",
        id: `msg_${user.id}_${number}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `done-${user.id}`, annotations: [] }]
      };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) }
    },
    ...(!tool
      ? [
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: `done-${user.id}`
          }
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        model: "fixture-model",
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      }
    }
  ];
  return new Response(
    events
      .map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
});
const gateway = new ModelGateway(
  {
    async reserve(input) {
      const user = owner(input.capability, "model");
      return {
        tenantId: "fixture",
        runId: user.id,
        callId: input.call.callId,
        providerId: "fixture",
        providerModel: "fixture-model",
        secretRef: user.id,
        bindingVersion: 1,
        maxOutputTokens: input.call.maxOutputTokens,
        receipt: "r".repeat(43)
      };
    },
    async dispatch() {},
    async finish() {}
  },
  {
    async read(input) {
      return owner(input.capability, "model").model;
    }
  },
  new Map([
    [
      "fixture",
      {
        async invoke() {
          throw Error("Wrong protocol");
        },
        respond: provider.invoke.bind(provider)
      }
    ]
  ])
);
const model = createModelServer(
  tls,
  "gateway.test",
  gateway,
  async token => {
    const user = owner(token, "model");
    return {
      runtime: { runtimeId: "probe", allocationId: user.id },
      expiresAt: Date.now() + 120000,
      wire: "responses",
      functions: ["mcp__fixture.read", ...(user.id === "first" ? [] : ["mcp__fixture.extra"])],
      maxOutputTokens: 1024
    };
  },
  timing => {
    if (timing.error) emit({ kind: "gateway-error", error: timing.error });
  }
);
// Observe route/status without changing the production handler or its validation.
model.prependListener("request", (req, res) => {
  res.on("finish", () => emit({ kind: "http", path: req.url, status: res.statusCode }));
});
const mcp = https.createServer(tls, async (req, res) => {
  try {
    const user = owner(req.headers.authorization?.slice(7), "tool");
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) throw Error("MCP input limit");
    }
    const body = JSON.parse(raw);
    emit({ kind: "mcp", run: user.id, method: body.method });
    let result;
    if (body.method === "initialize")
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" }
      };
    else if (body.method === "tools/list")
      result = {
        tools: ["read", "extra"].map(name => ({
          name,
          description: `Fixture ${name}`,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        }))
      };
    else if (body.method === "tools/call") {
      assert.equal(body.params.name, "read");
      result = { content: [{ type: "text", text: "native-history-proof-7f4a" }] };
    } else {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  } catch {
    res.writeHead(403).end();
  }
});
await Promise.all(
  [
    [model, 9443],
    [mcp, 9444]
  ].map(([server, port]) => new Promise(resolve => server.listen(port, "0.0.0.0", resolve)))
);
emit({ kind: "ready" });
