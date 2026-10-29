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
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSdkServer } from "../examples/mcp-sdk/server.mjs";
import { customerSdk, tools } from "../examples/mcp-sdk/tools.mjs";
import { exportConfig } from "../examples/mcp-sdk/export-config.mjs";
import { McpToolProvider } from "../dist/plugins/mcp/provider.js";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { LocalToolAuthority } from "../dist/gateway/tool/local-authority.js";
import { ToolGateway } from "../dist/gateway/tool/gateway.js";
import { createToolMcpServer } from "../dist/gateway/tool/mcp-server.js";
import { mcpFetch } from "../dist/plugins/mcp/transports.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("SDK template: HTTPS, Run grants, two principals, error hints and measured overhead", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandlane-sdk-proof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "ca.pem")
    ],
    { stdio: "ignore" }
  );
  const [key, cert] = await Promise.all(
    ["key.pem", "ca.pem"].map(f => readFile(path.join(dir, f)))
  );
  const principals = new Map(
    ["a", "b"].map(v => [
      "Bearer " + v.repeat(40),
      { tools: ["customer"], customers: { 1: "tenant-" + v } }
    ])
  );
  let calls = 0;
  const methods = [];
  const upstream = createSdkServer({ key, cert }, principals, {
    invoke: async (...args) => {
      calls++;
      return customerSdk(...args);
    },
    observe: method => methods.push(method)
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const closeServer = async server => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(() => closeServer(upstream));
  const config = exportConfig(
    `https://127.0.0.1:${upstream.address().port}/mcp`,
    path.join(dir, "ca.pem")
  );
  assert.deepEqual(config.servers[0].tools, tools);
  for (const v of ["a", "b"]) {
    const file = path.join(dir, v + ".key");
    await writeFile(file, v.repeat(40), { mode: 0o600 });
    config.bindings.push({
      server: "crm",
      tenantId: "tenant",
      userId: v,
      tools: ["crm_customer"],
      headerSecrets: { authorization: { file, prefix: "Bearer " } }
    });
  }
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  const registry = new RunCredentialRegistry();
  const credentials = [];
  const register = (user, enabledTools) => {
    const credential = registry.register(
      {
        jobId: user,
        generation: 1,
        runId: user,
        tenantId: "tenant",
        userId: user,
        tenantAccessId: user,
        conversationId: user,
        attributes: {},
        runtime: { runtimeId: "test", allocationId: user },
        harness: "claude-code",
        modelWire: "anthropic-messages",
        modelAlias: "test",
        providerModel: "test",
        baseUri: "https://unused.example",
        enabledTools,
        expiresAt: Date.now() + 60000
      },
      {
        modelKey: "model-key-not-forwarded",
        agentToken: { value: "platform".repeat(8), expiresAt: Date.now() + 60000 },
        leaseUntil: Date.now() + 60000
      }
    );
    credentials.push(credential);
    return credential;
  };
  t.after(() => credentials.forEach(c => registry.revoke(c)));
  const authority = new LocalToolAuthority(
    registry,
    { serverId: "tools", targetRef: "sdk-proof", targetVersion: 1 },
    provider.tools
  );
  const audit = [];
  const gateway = new ToolGateway(
    authority,
    authority,
    new Map([["tools", authority.bind(provider)]]),
    undefined,
    entry => audit.push(entry)
  );
  const edge = createToolMcpServer(
    { key, cert },
    "127.0.0.1",
    gateway,
    authority.lookup,
    provider.tools
  );
  await new Promise(resolve => edge.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(edge));
  const makeClient = async user => {
    const credential = register(user, ["crm_customer"]);
    const url = `https://127.0.0.1:${edge.address().port}/mcp`;
    const client = new Client({ name: "sdk-proof-cli", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer " + credential.capabilities().tool } },
        fetch: mcpFetch(url, new AbortController().signal, cert)
      })
    );
    t.after(() => client.close());
    return client;
  };
  const [a, b] = await Promise.all([makeClient("a"), makeClient("b")]);
  assert.equal((await a.listTools()).tools[0].name, "crm_customer");
  const call = (client, id) => client.callTool({ name: "crm_customer", arguments: { id } });
  const results = await Promise.all([call(a, "1"), call(b, "1")]);
  assert.match(JSON.stringify(results[0]), /tenant-a/);
  assert.match(JSON.stringify(results[1]), /tenant-b/);
  const missing = await call(a, "absent");
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing), /NOT_FOUND/);
  assert.equal(audit.at(-1).outcome, "FAILED");
  const unknownUser = await makeClient("unknown");
  const before = calls;
  assert.equal((await call(unknownUser, "1")).isError, true);
  assert.equal(audit.at(-1).outcome, "FAILED");
  assert.equal(calls, before);
  const noGrant = register("no-grant", []);
  await assert.rejects(
    gateway.invoke(noGrant.capabilities().tool, noGrant.grant.runtime, {
      callId: randomUUID(),
      toolAlias: "crm_customer",
      arguments: { id: "1" }
    })
  );
  assert.equal(calls, before);

  // Adapter round-trip vs the same in-memory SDK: no model/backend time included.
  const direct = [],
    remote = [];
  for (let i = 0; i < 20; i++) {
    let start = performance.now();
    await customerSdk(principals.values().next().value, { id: "1" });
    direct.push(performance.now() - start);
    start = performance.now();
    await provider.invoke(
      { callId: randomUUID(), toolAlias: "crm_customer", arguments: { id: "1" } },
      { tenantId: "tenant", userId: "a" },
      "unused",
      new AbortController().signal,
      Date.now() + 5000
    );
    remote.push(performance.now() - start);
  }
  const percentile = (values, p) =>
    Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1].toFixed(2));
  t.diagnostic(
    JSON.stringify({
      samples: 20,
      directP50Ms: percentile(direct, 0.5),
      adapterP50Ms: percentile(remote, 0.5),
      adapterP95Ms: percentile(remote, 0.95),
      transport: "localhost verified TLS, new client per call, stateless (no DELETE)",
      requests: methods.length
    })
  );
});
