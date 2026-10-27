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
/** Validation infrastructure only: real Gateway implementations, fixture authority/provider/API.
 * Loaded in a separate container; neither Worker code nor long-lived keys enter the CLI container.
 */
import assert from "node:assert/strict";
import { createModelServer } from "../../dist/gateway/model/model-server.js";
import { ModelGateway } from "../../dist/gateway/model/gateway.js";
import { ResponsesProvider } from "../../dist/gateway/model/responses-provider.js";
import { createToolMcpServer } from "../../dist/gateway/tool/mcp-server.js";
import { ToolGateway } from "../../dist/gateway/tool/gateway.js";
import { installPurefectMetadata } from "../../dist/plugins/purefect/purefect-catalog.js";

const config = JSON.parse(process.env.FIXTURE);
const emit = record => console.log(JSON.stringify(record));
const runtime = user => ({ runtimeId: "fixture-host", allocationId: `allocation-${user.id}` });
const numericId = user => (user.id === "a" ? "1" : user.id === "b" ? "2" : "3");
const toolName = user => (user.id === "b" ? "metadata.get_meta" : "metadata.get_raw");
const owner = (capability, audience, actual) => {
  const user = config.users.find(u => u[audience] === capability);
  assert.ok(user, "Unknown fixture capability");
  if (actual) assert.deepEqual(actual, runtime(user));
  return user;
};
const modelCalls = new Map();
const modelAuthority = {
  async reserve(input) {
    const user = owner(input.capability, "model", input.runtime);
    const permit = {
      tenantId: numericId(user),
      runId: numericId(user),
      callId: input.call.callId,
      providerId: "fixture",
      providerModel: "fixture-provider-model",
      secretRef: `secret-${user.id}`,
      bindingVersion: 1,
      maxOutputTokens: input.call.maxOutputTokens,
      receipt: "r".repeat(43)
    };
    modelCalls.set(permit.callId, { user, permit, state: "reserved" });
    return permit;
  },
  async dispatch(input) {
    const user = owner(input.capability, "model", input.runtime);
    const call = modelCalls.get(input.callId);
    assert.equal(call.user.id, user.id);
    assert.equal(call.state, "reserved");
    call.state = "dispatched";
  },
  async finish(input) {
    const call = modelCalls.get(input.permit.callId);
    assert.equal(call.state, "dispatched");
    call.state = input.outcome;
    emit({ kind: "model-receipt", user: call.user.id, outcome: input.outcome });
  }
};

// The Provider transport is deliberately synthetic: no paid API call or real key.
const provider = new ResponsesProvider(
  "https://fixture-provider.invalid",
  async (_url, options) => {
    const user = config.users.find(
      u => options.headers.authorization === `Bearer fixture-provider-key-${u.id}`
    );
    assert.ok(user);
    const body = JSON.parse(options.body);
    assert.ok(!("client_metadata" in body) && !("prompt_cache_key" in body));
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, "mcp__purefect");
    assert.equal(body.tools[0].tools.length, 1);
    const name = body.tools[0].tools[0].name;
    const output = body.input.filter(i => i.type === "function_call_output");
    const second = output.length > 0;
    if (second) {
      assert.ok(JSON.stringify(output).includes(`fixture-user-${user.id}`));
      assert.ok(!JSON.stringify(output).includes(`fixture-user-${user.id === "a" ? "b" : "a"}`));
    }
    const item = second
      ? {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `done-${user.id}`, annotations: [] }]
        }
      : {
          type: "function_call",
          id: "fc_fixture",
          call_id: "call_fixture",
          namespace: "mcp__purefect",
          name,
          arguments: JSON.stringify({ type: "model", code: "fixture.example" }),
          status: "completed"
        };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_fixture", status: "in_progress", output: [] }
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, ...(second ? { content: [] } : { arguments: "" }) }
      },
      ...(second
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
          model: "fixture-provider-model",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      }
    ];
    return new Response(
      events
        .map((e, sequence_number) => `data: ${JSON.stringify({ ...e, sequence_number })}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } }
    );
  }
);
const model = new ModelGateway(
  modelAuthority,
  {
    async read(input) {
      const user = owner(input.capability, "model", input.runtime);
      assert.equal(input.permit.secretRef, `secret-${user.id}`);
      return `fixture-provider-key-${user.id}`;
    }
  },
  new Map([
    [
      "fixture",
      {
        invoke: async () => {
          throw Error("Wrong protocol");
        },
        respond: provider.invoke.bind(provider)
      }
    ]
  ])
);

const toolAuthority = {
  async reserve(input) {
    const user = owner(input.capability, "tool", input.runtime);
    assert.equal(input.call.toolAlias, toolName(user));
    return {
      tenantId: numericId(user),
      userId: numericId(user),
      subjectUserId: numericId(user),
      actorTenantAccessId: numericId(user),
      credentialOwnerTenantAccessId: numericId(user),
      runId: numericId(user),
      attributes: { tenant_code: `tenant-${user.id}`, site: "fixture" },
      serverId: "purefect",
      serverVersion: 1,
      targetRef: "fixture",
      targetVersion: 1,
      toolVersion: 1,
      callId: input.call.callId,
      toolAlias: input.call.toolAlias,
      requestDigest: input.requestDigest,
      credentialRef: "${secret://vault::fixture}",
      credentialRow: null,
      bindingVersion: 1,
      credentialVersion: 1,
      expiresAt: Date.now() + 10000,
      receipt: "t".repeat(43)
    };
  },
  async dispatch() {},
  async finish(input) {
    emit({ kind: "tool-receipt", user: input.permit.userId, outcome: input.outcome });
  }
};
const installed = installPurefectMetadata(
  {
    gateway: "https://fixture-platform.invalid",
    targetRef: "fixture",
    targetVersion: 1
  },
  settings => ({
    async request(api, params) {
      const user = config.users.find(
        u => settings.accessToken === `fixture-pat-${u.id}`.padEnd(40, "x")
      );
      assert.ok(user);
      assert.equal(settings.tenantCode, `tenant-${user.id}`);
      assert.equal(
        api,
        `pf.designer.meta.MetaManager::${user.id === "b" ? "get_meta" : "get_raw"}`
      );
      assert.deepEqual(params, { type: "model", code: "fixture.example" });
      emit({ kind: "mcp", user: user.id, method: "tools/call", tool: toolName(user) });
      return { success: true, data: { result: `fixture-user-${user.id}` } };
    }
  })
);
const tool = new ToolGateway(
  toolAuthority,
  {
    async read(permit) {
      const user = config.users.find(u => numericId(u) === permit.userId);
      assert.ok(user);
      return {
        accessToken: `fixture-pat-${user.id}`.padEnd(40, "x"),
        expiresAt: Date.now() + 10000
      };
    }
  },
  new Map([["purefect", installed.adapter]])
);
const tls = { key: config.key, cert: config.cert };
const modelServer = createModelServer(
  tls,
  "gateway.test",
  {
    async respond(capability, bound, callId, body, policy, signal) {
      const user = owner(capability, "model", bound);
      emit({ kind: "model", user: user.id, body });
      const result = await model.respond(capability, bound, callId, body, policy, signal);
      assert.equal(modelCalls.get(callId).state, "SUCCEEDED");
      emit({ kind: "model-published", user: user.id });
      return result;
    }
  },
  async capability => {
    const user = owner(capability, "model");
    return {
      runtime: runtime(user),
      expiresAt: Date.now() + 20000,
      wire: "responses",
      functions: [`mcp__purefect.${toolName(user).replaceAll(".", "_")}`],
      maxOutputTokens: 1024
    };
  }
);
const toolServer = createToolMcpServer(
  tls,
  "gateway.test",
  tool,
  async capability => {
    const user = owner(capability, "tool");
    return {
      runtime: runtime(user),
      expiresAt: Date.now() + 20000,
      enabledTools: [toolName(user)]
    };
  },
  installed.adapter.tools
);
await Promise.all(
  [
    [modelServer, 9443],
    [toolServer, 9444]
  ].map(([server, port]) => new Promise(resolve => server.listen(port, "0.0.0.0", resolve)))
);
emit({ kind: "ready" });
