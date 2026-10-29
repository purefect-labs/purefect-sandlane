#!/usr/local/bin/node
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
import readline from "node:readline";
import https from "node:https";
import { readFileSync } from "node:fs";
import net from "node:net";

const config = JSON.parse(readFileSync("/app/probe.json", "utf8"));
const mcp = Object.values(
  JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers
)[0];
const toolName = "mcp__demo__demo_echo";
const session = "00000000-0000-4000-8000-000000000000";
const out = value => process.stdout.write(JSON.stringify({ ...value, session_id: session }) + "\n");
let stopped = false;
const request = (url, body, token, model = false) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(model
            ? { "x-api-key": token, "anthropic-version": "2023-06-01" }
            : { authorization: "Bearer " + token })
        }
      },
      res => {
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > 2_000_000) req.destroy(Error("RESPONSE_LIMIT"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.setTimeout(10_000, () => req.destroy(Error("REQUEST_TIMEOUT")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
const frames = text =>
  text
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
let rpcId = 0;
async function rpc(method, params) {
  const response = await request(
    mcp.url,
    { jsonrpc: "2.0", id: ++rpcId, method, params },
    process.env.SANDLANE_TOOL_CAPABILITY
  );
  if (response.status !== 200) throw Error("MCP_REJECTED");
  const message = response.text.trim().startsWith("{")
    ? JSON.parse(response.text)
    : frames(response.text)[0];
  if (!message?.result || message.error || message.result.isError) throw Error("MCP_FAILED");
  return message.result;
}
const blocked = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setTimeout(750, () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", () => resolve());
    socket.on("connect", () => {
      socket.destroy();
      reject(Error("DIRECT_GATEWAY_REACHABLE"));
    });
  });
async function turn(message) {
  out({
    type: "system",
    subtype: "init",
    tools: [toolName],
    mcp_servers: [{ name: "demo", status: "connected" }],
    permissionMode: "dontAsk",
    model: "sandlane"
  });
  await blocked(config.workerIp, 19443);
  await blocked(config.workerIp, 19444);
  const url = process.env.ANTHROPIC_BASE_URL + "/v1/messages";
  const wrong = await request(url, {}, process.env.SANDLANE_TOOL_CAPABILITY, true);
  if (wrong.status !== 401 && wrong.status !== 403)
    throw Error("WRONG_PURPOSE_CAPABILITY_ACCEPTED");
  const modelBody = {
    model: "sandlane",
    max_tokens: 256,
    stream: true,
    messages: [
      {
        role: "user",
        content: typeof message.message.content === "string" ? message.message.content : "demo"
      }
    ],
    tools: [
      {
        name: toolName,
        description: "Echo a nonce",
        input_schema: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false
        }
      }
    ]
  };
  const first = await request(url, modelBody, process.env.ANTHROPIC_API_KEY, true);
  if (first.status !== 200) throw Error("MODEL_REJECTED");
  const firstEvents = frames(first.text);
  const start = firstEvents.find(v => v.type === "content_block_start")?.content_block;
  const partial = firstEvents
    .filter(v => v.delta?.type === "input_json_delta")
    .map(v => v.delta.partial_json)
    .join("");
  if (start?.name !== toolName) throw Error("MODEL_TOOL_MISSING");
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "sandlane-fixture", version: "1" }
  });
  const list = await rpc("tools/list", {});
  if (!list.tools.some(v => v.name === "demo_echo")) throw Error("TOOL_NOT_LISTED");
  const input = JSON.parse(partial);
  out({ type: "assistant", message: { content: [{ ...start, input }] }, parent_tool_use_id: null });
  const result = await rpc("tools/call", { name: "demo_echo", arguments: input });
  const resultText = JSON.stringify(result.content);
  out({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: start.id, content: result.content }]
    },
    parent_tool_use_id: null
  });
  if (config.scenario !== "success") return; // Wait for host cancellation or lease loss.
  const second = await request(
    url,
    {
      ...modelBody,
      messages: [
        ...modelBody.messages,
        { role: "assistant", content: [{ ...start, input }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: start.id, content: resultText }]
        }
      ]
    },
    process.env.ANTHROPIC_API_KEY,
    true
  );
  if (second.status !== 200) throw Error("SECOND_MODEL_REJECTED");
  for (const event of frames(second.text)) {
    if (stopped) return;
    out({ type: "stream_event", event, parent_tool_use_id: null, uuid: "demo" });
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    usage: { input_tokens: 16, output_tokens: 16 }
  });
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    out({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: {} }
    });
    if (message.request.subtype === "interrupt") {
      stopped = true;
      out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming"
      });
    }
  } else if (message.type === "user") {
    void turn(message).catch(() =>
      out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "fixture_failure"
      })
    );
  }
}
