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
import { ModelGateway } from "../dist/gateway/model/gateway.js";
import { ResponsesProvider } from "../dist/gateway/model/responses-provider.js";

const capability = "c".repeat(43),
  receipt = "r".repeat(43);
const runtime = { runtimeId: "runtime", allocationId: "allocation" };
const request = { model: "alias", input: "hello", stream: true };
const policy = { functions: [], maxOutputTokens: 100 };

function setup({ finish = async () => {}, denied = false } = {}) {
  const calls = [];
  const authority = {
    reserve: async input => {
      calls.push("reserve");
      assert.equal(input.call.modelAlias, "alias");
      assert.match(input.call.requestDigest, /^[a-f0-9]{64}$/);
      return {
        tenantId: "1",
        runId: "2",
        callId: input.call.callId,
        providerId: "provider",
        providerModel: "allowed",
        secretRef: "tenant-secret",
        bindingVersion: 1,
        maxOutputTokens: input.call.maxOutputTokens,
        receipt
      };
    },
    dispatch: async () => {
      calls.push("dispatch");
      if (denied) throw Error("revoked");
    },
    finish: async input => {
      calls.push(input.outcome);
      await finish(input);
    }
  };
  const secrets = {
    read: async () => {
      calls.push("secret");
      return "private-model-key-12345";
    }
  };
  const provider = new ResponsesProvider("https://provider.example", async () => {
    calls.push("provider");
    const event = {
      type: "response.completed",
      sequence_number: 0,
      response: {
        id: "resp_1",
        model: "allowed",
        status: "completed",
        output: [],
        usage: { input_tokens: 3, output_tokens: 1 }
      }
    };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { "content-type": "text/event-stream" }
    });
  });
  const gateway = new ModelGateway(
    authority,
    secrets,
    new Map([
      [
        "provider",
        {
          invoke: async () => {
            throw Error("wrong protocol");
          },
          respond: provider.invoke.bind(provider)
        }
      ]
    ])
  );
  return { calls, gateway };
}

test("Responses shares reserve/exchange/dispatch/finish and publishes only after durable usage receipt", async () => {
  let release, entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const f = setup({
    finish: async input => {
      assert.equal(input.inputTokens, 3);
      assert.equal(input.outputTokens, 1);
      entered();
      await gate;
    }
  });
  let published = false;
  const pending = f.gateway.respond(capability, runtime, "call", request, policy).then(value => {
    published = true;
    return value;
  });
  await started;
  assert.equal(published, false);
  release();
  assert.equal((await pending).events.at(-1).type, "response.completed");
  assert.deepEqual(f.calls, ["reserve", "secret", "dispatch", "provider", "SUCCEEDED"]);
});

test("Responses revocation after key lookup prevents provider invocation", async () => {
  const f = setup({ denied: true });
  await assert.rejects(f.gateway.respond(capability, runtime, "call", request, policy));
  assert.deepEqual(f.calls, ["reserve", "secret", "dispatch", "FAILED"]);
});

test("Responses lost accounting acknowledgement returns no events and sends no contradictory receipt", async () => {
  const f = setup({
    finish: async () => {
      throw Error("reply lost");
    }
  });
  await assert.rejects(
    f.gateway.respond(capability, runtime, "call", request, policy),
    e => e.code === "MODEL_RECEIPT_UNCONFIRMED"
  );
  assert.deepEqual(f.calls, ["reserve", "secret", "dispatch", "provider", "SUCCEEDED"]);
});
