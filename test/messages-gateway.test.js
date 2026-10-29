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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { ModelGateway } from "../dist/gateway/model/gateway.js";
import { LocalModelAuthority } from "../dist/gateway/model/local-authority.js";
import { MessagesProvider } from "../dist/gateway/model/messages-provider.js";
import { createModelServer } from "../dist/gateway/model/model-server.js";
import { keepAliveSend } from "../dist/gateway/model/upstream-transport.js";

const MODEL_KEY = "sk-upstream-" + "k".repeat(40);
const TOOL = "mcp__tools__metadata_get_raw";
const usage = {
  input_tokens: 11,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 1
};

const frame = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (changes = {}) =>
  frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-up",
      content: [],
      usage,
      ...changes
    }
  });
const delta = (text, index = 0) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text }
  });
const textStart = (index = 0) =>
  frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" }
  });
const stop = index => frame("content_block_stop", { type: "content_block_stop", index });
const end = (output = 5) =>
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: output }
  }) + frame("message_stop", { type: "message_stop" });

function events(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map(block => {
      const [name, data] = block.split("\n");
      return { event: name.slice(7), data: data.slice(6) };
    });
}

async function certificate(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-messages-"));
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
    ["key", "cert"].map(n => readFile(path.join(root, `${n}.pem`)))
  );
  return { key, cert };
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

/** Mock provider, model gateway (server -> ModelGateway -> LocalModelAuthority -> provider) and
 * one registered Run per Harness. `upstream(req, body, res)` answers each provider call. */
async function setup(t, upstream, auth = "x-api-key", webAccess = undefined, basePath = "/v1") {
  const tls = await certificate(t);
  const received = [];
  const providerPort = await listen(
    t,
    https.createServer(tls, async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      received.push({ url: req.url, headers: req.headers, body });
      await upstream(req, body, res);
    })
  );
  const registry = new RunCredentialRegistry();
  const send = keepAliveSend({ ca: tls.cert });
  const models = new LocalModelAuthority(
    registry,
    {
      functions: { "claude-code": [TOOL], codex: ["mcp__tools.metadata_get_raw"] },
      webFunctions: { "claude-code": ["WebSearch"] },
      maxOutputTokens: 1000
    },
    {
      responses: () => assert.fail("no Responses upstream"),
      messages: base => new MessagesProvider(base, send, auth)
    }
  );
  const gateway = new ModelGateway(models, models, models.provider, {
    maxConcurrent: 8,
    timeoutMs: 10_000,
    receiptTimeoutMs: 1_000
  });
  const server = createModelServer(tls, "localhost", gateway, models.lookup);
  const port = await listen(t, server);
  const register = (harness, wire) =>
    registry.register(
      {
        jobId: "1",
        generation: 1,
        runId: "2",
        tenantId: "3",
        conversationId: "4",
        userId: "5",
        tenantAccessId: "5",
        attributes: {},
        runtime: { runtimeId: "rt", allocationId: "run-2-g1" },
        harness,
        modelWire: wire,
        modelAlias: "sandlane",
        providerModel: "claude-up",
        baseUri: `https://localhost:${providerPort}${basePath}`,
        enabledTools: ["metadata.get_raw"],
        ...(webAccess ? { webAccess } : {}),
        expiresAt: Date.now() + 60_000
      },
      {
        modelKey: MODEL_KEY,
        agentToken: { value: "agent-token-" + "t".repeat(40), expiresAt: Date.now() + 60_000 },
        leaseUntil: Date.now() + 60_000
      }
    );
  const claude = register("claude-code", "anthropic-messages");
  const capability = claude.capabilities().model;
  /** POST to the gateway; `onData` sees the response as it streams. */
  const call = ({ route = "/v1/messages?beta=true", headers = {}, body = {}, onData } = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          servername: "localhost",
          ca: tls.cert,
          method: "POST",
          headers: Object.fromEntries(
            Object.entries({
              host: `localhost:${port}`,
              "x-api-key": capability,
              "content-type": "application/json",
              ...headers
            }).filter(([, value]) => value !== undefined)
          )
        },
        res => {
          let output = "";
          res.on("data", bytes => {
            output += bytes.toString("utf8");
            onData?.(output);
          });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, output }));
        }
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          model: "sandlane",
          max_tokens: 500,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
          ...body
        })
      );
    });
  return { call, received, claude, capability, register, registry };
}

test("Messages streams provider events verbatim and unbuffered, forwards protocol headers and swaps credentials", async t => {
  let release;
  const released = new Promise(resolve => (release = resolve));
  const sent = [start(), frame("ping", { type: "ping" }), textStart(), delta("Hel")];
  const rest = [delta("lo"), stop(0), end()];
  const f = await setup(
    t,
    async (req, body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sent.join(""));
      await released;
      res.end(rest.join(""));
    },
    "x-api-key",
    undefined,
    "/apps/anthropic"
  );
  let streamedEarly = false;
  const response = await f.call({
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27,effort-2025-11-24"
    },
    body: {
      max_tokens: 5000,
      tools: [{ name: TOOL, description: "Read", input_schema: { type: "object" } }],
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: "low" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      metadata: { user_id: "opaque" },
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]
    },
    onData: output => {
      // The first text arrives while the provider still holds the rest of the answer.
      if (!streamedEarly && output.includes('"Hel"')) {
        streamedEarly = true;
        release();
      }
    }
  });
  assert.equal(streamedEarly, true);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^text\/event-stream/);
  const expected = events([...sent, ...rest].join(""));
  assert.deepEqual(
    events(response.output),
    expected,
    "every event, ping included, verbatim and in order"
  );

  const [upstream] = f.received;
  assert.equal(upstream.url, "/apps/anthropic/v1/messages?beta=true");
  assert.equal(upstream.headers["x-api-key"], MODEL_KEY);
  assert.equal(upstream.headers.authorization, undefined);
  assert.equal(upstream.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    upstream.headers["anthropic-beta"],
    "context-management-2025-06-27,effort-2025-11-24"
  );
  assert.ok(
    !JSON.stringify(upstream).includes(f.capability),
    "the CLI's capability never goes upstream"
  );
  assert.equal(upstream.body.model, "claude-up");
  assert.equal(upstream.body.max_tokens, 1000, "lowered to the deployment ceiling");
  for (const field of [
    "thinking",
    "output_config",
    "context_management",
    "metadata",
    "system",
    "tools"
  ])
    assert.ok(upstream.body[field], field);
  assert.deepEqual(upstream.body.system[0].cache_control, { type: "ephemeral" });
  // message_start input (uncached + cache writes + reads) and message_delta output.
  assert.deepEqual(f.claude.usage, { input_tokens: 16, output_tokens: 5 });
});

test("Messages rejects requests outside the Run's boundaries in Anthropic error form", async t => {
  const f = await setup(t, async (req, body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(start() + end(1));
  });
  const rejected = async (options, status, type) => {
    const response = await f.call(options);
    assert.equal(response.status, status, JSON.stringify(options));
    if (type) assert.equal(JSON.parse(response.output).error.type, type);
  };
  await rejected(
    { body: { tools: [{ name: "mcp__other__x", input_schema: {} }] } },
    400,
    "invalid_request_error"
  );
  await rejected({ body: { tools: [{ type: "web_search_20250305", name: TOOL }] } }, 400);
  await rejected({ body: { mcp_servers: [{ type: "url", url: "https://x.example" }] } }, 400);
  await rejected(
    {
      body: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }]
          }
        ]
      }
    },
    400
  );
  await rejected(
    {
      body: {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] }
        ]
      }
    },
    400
  );
  await rejected({ body: { stream: false } }, 400);
  await rejected({ body: { model: "claude-opus" } }, 403, "permission_error");
  await rejected({ route: "/v1/messages/count_tokens?beta=true" }, 404, "not_found_error");
  await rejected(
    { headers: { authorization: `Bearer ${"z".repeat(43)}` } },
    401,
    "authentication_error"
  );
  // A Codex Run's capability does not open the Messages entry, nor a Messages one the Responses entry.
  const codex = f.register("codex", "responses").capabilities().model;
  await rejected({ headers: { "x-api-key": codex } }, 401);
  await rejected(
    {
      route: "/v1/responses",
      headers: { "x-api-key": undefined, authorization: `Bearer ${f.capability}` }
    },
    401
  );
  assert.equal(f.received.length, 0, "nothing reached the provider");
  // Bearer works as well (ANTHROPIC_AUTH_TOKEN), and so do both when they agree.
  const both = await f.call({
    route: "/v1/messages",
    headers: { authorization: `Bearer ${f.capability}` }
  });
  assert.equal(both.status, 200);
  assert.equal(f.received[0].url, "/v1/messages");
});

test("provider errors reach the CLI unchanged; credentials and provider tools never do", async t => {
  const replies = [];
  const f = await setup(
    t,
    async (req, body, res) => {
      const reply = replies.shift();
      await reply(res);
    },
    "both"
  );
  replies.push(res => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
  });
  const limited = await f.call();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "7");
  assert.equal(
    limited.output,
    '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'
  );
  assert.equal(f.received[0].headers["x-api-key"], MODEL_KEY);
  assert.equal(f.received[0].headers.authorization, `Bearer ${MODEL_KEY}`);

  replies.push(res => {
    res.writeHead(500, { "content-type": "text/html" });
    res.end(`<html>${MODEL_KEY}</html>`);
  });
  const opaque = await f.call();
  assert.equal(opaque.status, 500);
  assert.equal(JSON.parse(opaque.output).error.type, "api_error");
  assert.ok(!opaque.output.includes(MODEL_KEY));

  replies.push(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      start() +
        textStart() +
        delta("par") +
        frame("error", {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" }
        })
    );
  });
  const overloaded = events((await f.call()).output);
  assert.deepEqual(overloaded.at(-1), {
    event: "error",
    data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
  });

  // A credential split across deltas is held back and the stream fails before it appears.
  replies.push(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      start() +
        textStart() +
        delta(`key ${MODEL_KEY.slice(0, 20)}`) +
        delta(MODEL_KEY.slice(20)) +
        stop(0) +
        end()
    );
  });
  const leaked = await f.call();
  assert.ok(!leaked.output.includes(MODEL_KEY.slice(0, 20)));
  assert.equal(events(leaked.output).at(-1).event, "error");

  // A provider-side tool block never enters the CLI stream.
  replies.push(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      start() +
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "s", name: "web_search", input: {} }
        }) +
        end()
    );
  });
  const hosted = await f.call();
  assert.ok(!hosted.output.includes("server_tool_use"));
  assert.equal(events(hosted.output).at(-1).event, "error");
});

test("tool calls wait for accounting, and revocation aborts the provider stream", async t => {
  let aborted;
  const providerClosed = new Promise(resolve => (aborted = resolve));
  let mode = "tool";
  const f = await setup(t, async (req, body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "tool") {
      res.end(
        start() +
          frame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: TOOL, input: {} }
          }) +
          frame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"code":"a"}' }
          }) +
          stop(0) +
          end(9)
      );
      return;
    }
    res.write(start() + textStart() + delta("partial"));
    req.socket.once("close", aborted);
  });
  const tool = await f.call({
    body: { tools: [{ name: TOOL, input_schema: { type: "object" } }] }
  });
  assert.deepEqual(
    events(tool.output).map(e => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]
  );
  assert.deepEqual(f.claude.usage, { input_tokens: 16, output_tokens: 9 });

  mode = "hang";
  const pending = f.call({
    onData: output => {
      if (output.includes('"partial"')) f.registry.revoke(f.claude);
    }
  });
  await providerClosed;
  const cut = await pending;
  assert.ok(cut.output.includes('"partial"'));
  assert.notEqual(events(cut.output).at(-1).event, "message_stop");
});

/** Claude Code's WebSearch, as measured with CLI 2.1.301: the main request offers the client tool
 * `WebSearch`; running it, the CLI sends a request of its own with the provider's tool. */
const WEB_SEARCH_TOOL = {
  name: "WebSearch",
  description: "Search the web",
  input_schema: { type: "object", properties: { query: { type: "string" } } }
};
const searchRequest = (tool = {}) => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "Perform a web search for the query: x" }] }
  ],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, ...tool }],
  tool_choice: { type: "auto" }
});
const searchReply = () =>
  start() +
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }
  }) +
  stop(0) +
  frame("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://docs.example.com/a", title: "A" }]
    }
  }) +
  stop(1) +
  textStart(2) +
  delta("Summary.", 2) +
  stop(2) +
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5, server_tool_use: { web_search_requests: 2 } }
  }) +
  frame("message_stop", { type: "message_stop" });

test("web access allowlist: WebSearch offered, provider search narrowed, its blocks streamed and counted", async t => {
  const f = await setup(
    t,
    async (req, body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.tools?.some(tool => tool.type) ? searchReply() : start() + end());
    },
    "x-api-key",
    { mode: "allowlist", domains: ["example.com", "example.org"] }
  );
  const main = await f.call({ body: { tools: [WEB_SEARCH_TOOL] } });
  assert.equal(main.status, 200);
  assert.deepEqual(
    f.received[0].body.tools.map(tool => tool.name),
    ["WebSearch"]
  );
  const search = await f.call({
    body: searchRequest({
      allowed_domains: ["docs.example.com", "foreign.test"],
      blocked_domains: ["x.example.com"]
    })
  });
  assert.equal(search.status, 200);
  assert.deepEqual(f.received[1].body.tools, [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 8,
      allowed_domains: ["docs.example.com"]
    }
  ]);
  const forwarded = events(search.output).map(e => JSON.parse(e.data).content_block?.type);
  assert.ok(forwarded.includes("server_tool_use"));
  assert.ok(forwarded.includes("web_search_tool_result"));
  assert.equal(events(search.output).at(-1).event, "message_stop");
  assert.equal(f.claude.webSearches, 2);
  // Without a CLI filter the allowlist itself is the filter.
  await f.call({ body: searchRequest() });
  assert.deepEqual(f.received[2].body.tools[0].allowed_domains, ["example.com", "example.org"]);
  // A filter outside the allowlist leaves nothing to search: the tool is removed.
  await f.call({ body: searchRequest({ allowed_domains: ["foreign.test"] }) });
  assert.equal(f.received[3].body.tools, undefined);
  assert.equal(f.received[3].body.tool_choice, undefined);
});

test("web access open passes the provider search unchanged; other provider tools stay rejected", async t => {
  const f = await setup(
    t,
    async (req, body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(searchReply());
    },
    "x-api-key",
    { mode: "open", domains: [] }
  );
  const request = searchRequest({ blocked_domains: ["bad.example"] });
  assert.equal((await f.call({ body: request })).status, 200);
  assert.deepEqual(f.received[0].body.tools, request.tools);
  for (const tool of [
    { type: "code_execution_20250522", name: "code_execution" },
    { type: "web_fetch_20250910", name: "web_fetch" },
    { type: "web_search_20250305", name: "renamed" }
  ]) {
    const rejected = await f.call({ body: { tools: [tool] } });
    assert.equal(rejected.status, 400, tool.name);
  }
  assert.equal(
    (await f.call({ body: { mcp_servers: [{ type: "url", url: "https://x.example" }] } })).status,
    400
  );
  assert.equal(f.received.length, 1);
});

test("web access off: WebSearch and the provider search are removed, not rejected", async t => {
  const f = await setup(t, async (req, body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(start() + end());
  });
  const main = await f.call({
    body: { tools: [WEB_SEARCH_TOOL, { name: TOOL, input_schema: {} }] }
  });
  assert.equal(main.status, 200);
  assert.deepEqual(
    f.received[0].body.tools.map(tool => tool.name),
    [TOOL]
  );
  const search = await f.call({ body: searchRequest() });
  assert.equal(search.status, 200);
  assert.equal(f.received[1].body.tools, undefined);
  assert.equal(f.received[1].body.tool_choice, undefined);
  // History naming the withheld tool, or provider search blocks, cannot occur without access.
  const history = await f.call({
    body: {
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "WebSearch", input: {} }]
        }
      ]
    }
  });
  assert.equal(history.status, 400);
});
