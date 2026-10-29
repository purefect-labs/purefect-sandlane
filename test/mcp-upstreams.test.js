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
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  McpToolProvider,
  parseMcpConfig,
  combineToolProviders,
  loadMcpToolProvider
} from "../dist/plugins/mcp/provider.js";
import { demoTools } from "../dist/plugins/standalone/tools.js";

const tool = {
  alias: "external_echo",
  remoteName: "echo",
  readOnly: true,
  description: "Echo",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" }, mode: { type: "string" } },
    additionalProperties: false
  }
};
const identity = user => ({
  tenantId: "t1",
  userId: user,
  actorTenantAccessId: "m1",
  runId: user,
  attributes: {},
  serverId: "tools",
  serverVersion: 1,
  targetRef: "tools",
  targetVersion: 1,
  toolVersion: 1
});
const invoke = (
  provider,
  user = "u1",
  args = { value: "hello" },
  signal = new AbortController().signal
) =>
  provider.invoke(
    { callId: randomUUID(), toolAlias: tool.alias, arguments: args },
    identity(user),
    "platform-token-must-not-leave",
    signal,
    Date.now() + 5000
  );
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandlane-mcp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = [path.join(dir, "a.key"), path.join(dir, "b.key")];
  await Promise.all(
    keys.map((file, i) => writeFile(file, (i ? "b" : "a").repeat(40), { mode: 0o600 }))
  );
  const config = {
    servers: [
      {
        id: "test",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [path.resolve("fixtures/mcp-upstream.mjs")],
          cwd: path.resolve(".")
        },
        tools: [tool]
      }
    ],
    bindings: keys.map((file, i) => ({
      server: "test",
      tenantId: "t1",
      userId: `u${i + 1}`,
      tools: [tool.alias],
      envSecrets: { TEST_KEY: file }
    })),
    ...extra
  };
  return { dir, keys, config };
}

test("stdio uses isolated sessions, selected user keys and no inherited environment", async t => {
  const { config } = await fixture(t);
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  process.env.SANDLANE_TEST_AMBIENT = "do-not-inherit";
  t.after(() => delete process.env.SANDLANE_TEST_AMBIENT);
  const [a, b] = await Promise.all([invoke(provider), invoke(provider, "u2")]);
  const av = JSON.parse(a.content[0].text),
    bv = JSON.parse(b.content[0].text);
  assert.equal(av.value, "hello");
  assert.equal(av.keyTag, "a");
  assert.equal(bv.keyTag, "b");
  assert.notEqual(av.pid, bv.pid);
  assert.equal(av.ambient, null);
  assert.equal(av.home, null);
  for (const pid of [av.pid, bv.pid]) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(invoke(provider, "unknown"), /MCP_ACCESS/);
  assert.throws(
    () => invoke(provider, "u1", { endpoint: "https://evil.example" }),
    /INVALID_TOOL_ARGUMENTS/
  );
  await assert.rejects(invoke(provider, "u1", { mode: "leak" }), /MCP_CALL_FAILED/);
  await assert.rejects(
    invoke(provider, "u1", { mode: "error" }),
    error => error.definite === true && error.code === "MCP_TOOL_ERROR"
  );
});

test("stdio cancellation, concurrency, overflow and close are bounded", async t => {
  const { config } = await fixture(t, { timeoutMs: 500, maxConcurrent: 1 });
  const provider = new McpToolProvider(config);
  const stop = new AbortController();
  const pending = invoke(provider, "u1", { mode: "hang" }, stop.signal);
  await assert.rejects(invoke(provider), error => /BUSY/.test(error.code) && error.definite);
  stop.abort();
  await assert.rejects(pending);
  await assert.rejects(invoke(provider, "u1", { mode: "overflow" }));
  const last = invoke(provider, "u1", { mode: "hang" });
  const rejected = assert.rejects(last);
  await provider.close();
  await rejected;
  await assert.rejects(invoke(provider), /UNAVAILABLE/);
});

test("config rejects unsafe/ambiguous routes, grants and tool schemas", async t => {
  const { config, dir } = await fixture(t);
  const changes = [
    c => {
      c.servers[0].transport.command = "npx";
    },
    c => {
      c.bindings[0].tenantId = "*";
    },
    c => {
      c.bindings.push(c.bindings[0]);
    },
    c => {
      c.servers.push(c.servers[0]);
    },
    c => {
      c.servers[0].tools[0].inputSchema.additionalProperties = true;
    },
    c => {
      c.servers[0].transport = { type: "http", url: "http://localhost/mcp" };
    },
    c => {
      c.servers[0].transport = { type: "http", url: "https://a:b@localhost/mcp" };
    },
    c => {
      c.bindings[0].envSecrets.NODE_OPTIONS = "/tmp/secret";
    }
  ];
  for (const change of changes) {
    const copy = structuredClone(config);
    change(copy);
    assert.throws(() => parseMcpConfig(copy));
  }
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await (await loadMcpToolProvider(file)).close();
});

test("definite pre-call refusals and read errors stay distinct from write/transport unknowns", async t => {
  const { config } = await fixture(t, { timeoutMs: 500 });
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  await assert.rejects(
    invoke(provider, "unbound"),
    e => e.definite === true && /ACCESS/.test(e.code)
  );
  await assert.rejects(
    provider.invoke(
      { callId: "expired", toolAlias: tool.alias, arguments: {} },
      identity("u1"),
      "unused",
      new AbortController().signal,
      Date.now() - 1
    ),
    e => e.definite === true && e.code === "MCP_CREDENTIAL_EXPIRED"
  );
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(invoke(provider, "u1", {}, stopped.signal), e => e.definite === true);
  await assert.rejects(invoke(provider, "u1", { mode: "hang" }), e => e.definite === false);
  const writable = structuredClone(config);
  writable.servers[0].tools[0].readOnly = false;
  const writer = new McpToolProvider(writable);
  t.after(() => writer.close());
  await assert.rejects(
    invoke(writer, "u1", { mode: "error" }),
    e => e.definite === false && e.code === "MCP_TOOL_ERROR"
  );
  const missing = structuredClone(config);
  missing.bindings[0].envSecrets.TEST_KEY += ".absent";
  const noSecret = new McpToolProvider(missing);
  t.after(() => noSecret.close());
  await assert.rejects(
    invoke(noSecret),
    e => e.definite === true && e.code === "MCP_PREPARATION_FAILED"
  );
});

test("running stdio cancellation kills the started process; tenant binding never crosses tenants", async t => {
  const { config, dir } = await fixture(t, { timeoutMs: 2500 });
  const pidFile = path.join(dir, "child.pid");
  config.servers[0].transport.env = { TEST_PID_FILE: pidFile };
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  const stop = new AbortController();
  const work = invoke(provider, "u1", { mode: "hang" }, stop.signal);
  const rejected = assert.rejects(work);
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    try {
      pid = Number(await readFile(pidFile, "utf8"));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  assert.ok(pid, "MCP call actually reached a running subprocess");
  stop.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(
    provider.invoke(
      { callId: "foreign", toolAlias: tool.alias, arguments: {} },
      { ...identity("u1"), tenantId: "t2" },
      "unused",
      new AbortController().signal,
      Date.now() + 1000
    ),
    /MCP_ACCESS/
  );
});

test("exact user binding replaces tenant grant and secrets are read again after rotation", async t => {
  const { config, keys } = await fixture(t);
  config.servers[0].tools.push({ ...tool, alias: "other_echo" });
  config.bindings[0].tools = ["other_echo"];
  config.bindings[1].userId = "*";
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  await assert.rejects(invoke(provider), /MCP_ACCESS/);
  assert.equal(JSON.parse((await invoke(provider, "another")).content[0].text).keyTag, "b");
  await writeFile(keys[1], "c".repeat(40));
  assert.equal(JSON.parse((await invoke(provider, "another")).content[0].text).keyTag, "c");
});

test("combined providers preserve existing tools, approvals and duplicate rejection", async t => {
  const { config } = await fixture(t);
  const external = new McpToolProvider(config);
  t.after(() => external.close());
  const base = demoTools();
  const combined = combineToolProviders(base, external);
  assert.deepEqual(
    combined.tools.map(t => t.alias),
    ["demo_echo", "external_echo"]
  );
  const input = { callId: "1", toolAlias: "demo_echo", arguments: { nonce: "ok" } };
  combined.validate(input, {});
  assert.deepEqual(
    await combined.invoke(
      input,
      { tenantId: "demo", userId: "demo" },
      "",
      new AbortController().signal,
      Date.now() + 1000
    ),
    { nonce: "ok" }
  );
  assert.throws(() => combineToolProviders(base, base), /DUPLICATE/);
  const guarded = {
    ...base,
    confirmation: () => ({ title: "approve", summary: "write" }),
    summarize: () => ({ operation: "write" })
  };
  assert.equal(combineToolProviders(guarded, external).confirmation(input, ["*"]).title, "approve");
  assert.equal(combineToolProviders(guarded, external).summarize(input).operation, "write");
});

test("HTTP MCP initializes and calls with separate user auth; TLS and redirects fail closed", async t => {
  const { config, dir, keys } = await fixture(t);
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
  const seen = [],
    live = new Map();
  let sessionsCreated = 0,
    sessionsDeleted = 0;
  const server = https.createServer({ key, cert }, async (req, res) => {
    seen.push({ authorization: req.headers.authorization, method: req.method, url: req.url });
    if (req.url === "/redirect") {
      res.writeHead(307, { location: "/mcp" });
      res.end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      const session = live.get(sessionId);
      assert.ok(session);
      assert.equal(session.authorization, req.headers.authorization);
      await session.transport.handleRequest(req, res);
      if (req.method === "DELETE") {
        sessionsDeleted++;
        live.delete(sessionId);
        await session.mcp.close();
      }
      return;
    }
    const mcp = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(CallToolRequestSchema, async request => ({
      content: [{ type: "text", text: request.params.arguments.value }]
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: false,
      onsessioninitialized: id => {
        sessionsCreated++;
        live.set(id, { transport, mcp, authorization: req.headers.authorization });
      }
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const item of live.values()) await item.mcp.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  config.servers[0].transport = {
    type: "http",
    url: `https://127.0.0.1:${server.address().port}/mcp`,
    caFile: path.join(dir, "ca.pem")
  };
  config.bindings = keys.map((file, i) => ({
    server: "test",
    tenantId: "t1",
    userId: `u${i + 1}`,
    tools: [tool.alias],
    headerSecrets: { authorization: { file, prefix: "Bearer " } }
  }));
  const provider = new McpToolProvider(config);
  t.after(() => provider.close());
  const results = await Promise.all([
    invoke(provider),
    invoke(provider, "u2", { value: "second" })
  ]);
  assert.equal(results[0].content[0].text, "hello");
  assert.equal(results[1].content[0].text, "second");
  assert.ok(seen.some(x => x.authorization === "Bearer " + "a".repeat(40)));
  assert.ok(seen.some(x => x.authorization === "Bearer " + "b".repeat(40)));
  assert.ok(seen.every(x => !JSON.stringify(x).includes("platform-token")));
  assert.equal(sessionsCreated, 2);
  assert.equal(sessionsDeleted, 2);
  assert.equal(live.size, 0);
  const untrusted = structuredClone(config);
  delete untrusted.servers[0].transport.caFile;
  const badTls = new McpToolProvider(untrusted);
  await assert.rejects(invoke(badTls));
  await badTls.close();
  config.servers[0].transport.url = config.servers[0].transport.url.replace("/mcp", "/redirect");
  const redirect = new McpToolProvider(config);
  const before = seen.length;
  await assert.rejects(invoke(redirect));
  await redirect.close();
  assert.ok(seen.slice(before).every(x => x.url === "/redirect"));
});
