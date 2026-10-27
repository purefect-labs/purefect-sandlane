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
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModelServer } from "../dist/gateway/model/model-server.js";
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";

test("Responses HTTPS derives separate runtime bindings from capabilities and rejects browser/expired/identity requests", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-responses-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem")
    ],
    { stdio: "ignore" }
  );
  const [key, cert] = await Promise.all(
    ["key", "cert"].map(name => readFile(path.join(root, `${name}.pem`)))
  );
  const calls = [];
  const bindings = new Map(
    ["a", "b"].map(id => [
      id.repeat(43),
      {
        runtime: { runtimeId: "host", allocationId: `allocation-${id}` },
        expiresAt: Date.now() + 30000,
        wire: "responses",
        functions: [],
        maxOutputTokens: 100
      }
    ])
  );
  const server = createModelServer(
    { key, cert },
    "localhost",
    {
      respond: async (capability, runtime, callId, input, policy) => {
        parseResponsesRequest(input, policy.functions, policy.maxOutputTokens);
        assert.equal(runtime.allocationId, bindings.get(capability).runtime.allocationId);
        calls.push({ runtime, callId });
        return {
          events: [
            { type: "response.completed", sequence_number: 0, response: { status: "completed" } }
          ],
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    },
    async capability => bindings.get(capability) ?? null
  );
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const request = (
    token = "a".repeat(43),
    body = { model: "alias", stream: true, input: "hello" },
    headers = {},
    route = "/v1/responses"
  ) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: route,
          servername: "localhost",
          ca: cert,
          method: "POST",
          headers: {
            host: `localhost:${server.address().port}`,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...headers
          }
        },
        res => {
          let output = "";
          res.on("data", bytes => {
            output += bytes.toString("utf8");
          });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, output }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const results = await Promise.all([request(), request("b".repeat(43))]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.match(result.output, /event: response.completed/);
  }
  assert.deepEqual(
    new Set(calls.map(call => call.runtime.allocationId)),
    new Set(["allocation-a", "allocation-b"])
  );
  assert.notEqual(calls[0].callId, calls[1].callId);
  assert.equal((await request("x".repeat(43))).status, 401);
  assert.equal(
    (await request(undefined, undefined, { origin: "https://browser.example" })).status,
    403
  );
  assert.equal((await request(undefined, undefined, {}, "/v1/responses?tenant=other")).status, 404);
  assert.equal(
    (
      await request(undefined, {
        model: "alias",
        stream: true,
        input: "hello",
        runtimeId: "foreign"
      })
    ).status,
    503
  );
  bindings.get("a".repeat(43)).expiresAt = Date.now() - 1;
  assert.equal((await request()).status, 401);
  assert.equal(calls.length, 2);
});
