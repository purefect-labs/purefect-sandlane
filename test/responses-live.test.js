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
import { ModelGateway } from "../dist/gateway/model/gateway.js";
import { ResponsesProvider } from "../dist/gateway/model/responses-provider.js";
import { createModelServer } from "../dist/gateway/model/model-server.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};
const secret = "private-provider-key-12345";
const frame = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const completed = sequence_number => ({
  type: "response.completed",
  sequence_number,
  response: {
    id: "response1",
    model: "model1",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 }
  }
});

for (const mode of ["success", "accounting-failure", "disconnect"]) {
  test(
    `real HTTPS streams before upstream completion and handles ${mode}`,
    { timeout: 10000 },
    async t => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "pf-live-sse-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
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
          path.join(directory, "key"),
          "-out",
          path.join(directory, "cert")
        ],
        { stdio: "ignore" }
      );
      const [key, cert] = await Promise.all(
        ["key", "cert"].map(name => readFile(path.join(directory, name)))
      );
      const first = deferred(),
        accounting = deferred(),
        releaseAccounting = deferred(),
        cancelled = deferred();
      let controller,
        output = "",
        outcome;
      const provider = new ResponsesProvider(
        "https://provider.example",
        async () =>
          new Response(
            new ReadableStream({
              start(value) {
                controller = value;
                value.enqueue(
                  frame({ type: "response.output_text.delta", sequence_number: 0, delta: "hello!" })
                );
              },
              cancel() {
                cancelled.resolve();
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
      );
      const gateway = new ModelGateway(
        {
          reserve: async ({ call }) => ({
            tenantId: "1",
            runId: "2",
            callId: call.callId,
            providerId: "provider",
            providerModel: "model1",
            secretRef: "secret1",
            bindingVersion: 1,
            maxOutputTokens: call.maxOutputTokens,
            receipt: "r".repeat(43)
          }),
          dispatch: async () => {},
          finish: async input => {
            outcome = input.outcome;
            accounting.resolve();
            await releaseAccounting.promise;
            if (mode === "accounting-failure") throw Error("lost acknowledgement");
          }
        },
        { read: async () => secret },
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
      const server = createModelServer({ key, cert }, "localhost", gateway, async () => ({
        runtime: { runtimeId: "host", allocationId: "allocation" },
        expiresAt: Date.now() + 30000,
        wire: "responses",
        functions: [],
        maxOutputTokens: 100
      }));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      t.after(() => {
        releaseAccounting.resolve();
        server.closeAllConnections();
        server.close();
      });
      let response;
      const ended = new Promise((resolve, reject) => {
        const request = https.request(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: "/v1/responses",
            servername: "localhost",
            ca: cert,
            method: "POST",
            headers: {
              host: "localhost",
              authorization: `Bearer ${"c".repeat(43)}`,
              "content-type": "application/json"
            }
          },
          res => {
            response = res;
            res.on("data", bytes => {
              output += bytes.toString();
              if (output.includes("hello!")) first.resolve();
            });
            res.on("end", resolve);
            res.on("close", resolve);
            res.on("error", error => (mode === "success" ? reject(error) : resolve()));
          }
        );
        request.on("error", reject);
        request.end(JSON.stringify({ model: "alias", stream: true, input: "hello" }));
      });
      // Upstream is deliberately still open: buffering until completion deadlocks this assertion.
      await first.promise;
      assert.equal(outcome, undefined);
      assert.doesNotMatch(output, /response.completed/);
      if (mode === "disconnect") {
        response.destroy();
        await cancelled.promise;
        await accounting.promise;
        assert.equal(outcome, "UNKNOWN");
      } else {
        controller.enqueue(frame(completed(1)));
        controller.close();
        await accounting.promise;
        assert.doesNotMatch(output, /response.completed/);
        assert.equal(outcome, "SUCCEEDED");
      }
      releaseAccounting.resolve();
      await ended;
      assert.equal((output.match(/hello!/g) ?? []).length, 1);
      assert.equal(output.includes("response.completed"), mode === "success");
    }
  );
}

test("live publication holds split secrets even when other channels interleave", async () => {
  const events = [
    { type: "response.output_text.delta", item_id: "one", delta: secret.slice(0, 10) },
    { type: "response.reasoning_text.delta", item_id: "two", delta: "ordinary text!" },
    { type: "response.output_text.delta", item_id: "one", delta: secret.slice(10) },
    completed(3)
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  const provider = new ResponsesProvider(
    "https://provider.example",
    async () =>
      new Response(new Blob(events.map(frame)), {
        headers: { "content-type": "text/event-stream" }
      })
  );
  const published = [];
  await assert.rejects(
    provider.invoke(
      { model: "alias", stream: true, input: "hello", max_output_tokens: 100 },
      "model1",
      secret,
      [],
      new AbortController().signal,
      async event => {
        published.push(event);
      }
    )
  );
  assert.deepEqual(published, []);
});
