#!/usr/bin/env node
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
/** Stand-in for `claude -p --input-format stream-json --output-format stream-json`: line shapes
 * as measured with Claude Code 2.1.301. FAKE_MODE picks the turn; every stdin line is appended to
 * FAKE_LOG. */
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "text";
const session = "00000000-0000-4000-8000-000000000000";
const out = value => process.stdout.write(`${JSON.stringify({ ...value, session_id: session })}\n`);
const event = (value, parent = null) =>
  out({ type: "stream_event", event: value, parent_tool_use_id: parent, uuid: "u" });
const text = (index, parts, parent = null) => {
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, parent);
  for (const part of parts)
    event(
      { type: "content_block_delta", index, delta: { type: "text_delta", text: part } },
      parent
    );
  event({ type: "content_block_stop", index }, parent);
};
const usage = {
  input_tokens: 11,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 5
};
const result = (changes = {}) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ignored",
    terminal_reason: "completed",
    usage,
    ...changes
  });
const builtins = { "web-search": ["WebSearch"], "foreign-tool": ["WebSearch", "Bash"] }[mode] ?? [];
const init = (servers = [{ name: "tools", status: "connected" }]) =>
  out({
    type: "system",
    subtype: "init",
    tools: servers.every(s => s.status === "connected")
      ? [...builtins, "mcp__tools__metadata_get_raw"]
      : [],
    mcp_servers: servers,
    permissionMode: "dontAsk",
    model: "sandlane"
  });

let streaming;
let answered;
function turn() {
  if (mode === "mcp-failed") {
    init([{ name: "tools", status: "failed" }]);
    text(0, ["must not be reported"]);
    result();
    return;
  }
  init();
  out({ type: "system", subtype: "status", status: "requesting" });
  event({ type: "message_start", message: { id: "msg_1", content: [], usage } });
  if (mode === "error") {
    out({
      type: "assistant",
      message: { content: [{ type: "text", text: "API Error: 400" }] },
      parent_tool_use_id: null
    });
    result({ is_error: true, terminal_reason: "api_error", api_error_status: 400 });
    return;
  }
  if (mode === "slow") {
    let n = 0;
    streaming = setInterval(() => {
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `w${n++} ` }
      });
    }, 20);
    return;
  }
  if (mode === "web-search") {
    // WebSearch: the CLI runs the provider's search in a request of its own and hands the model a
    // text summary; the stream shows only the client-side tool call and its result.
    const call = {
      type: "tool_use",
      id: "toolu_ws",
      name: "WebSearch",
      input: { query: "  latest\nrelease  notes ", allowed_domains: ["example.com"] }
    };
    out({ type: "assistant", message: { content: [call] }, parent_tool_use_id: null });
    out({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_ws",
            content: 'Web search results for query: "latest release notes" Links: [secret page]'
          }
        ]
      },
      parent_tool_use_id: null
    });
    text(0, ["Found it."]);
    result();
    return;
  }
  if (mode === "tool") {
    text(0, ["Checking."]);
    const call = {
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__tools__metadata_get_raw",
      input: { type: "model", code: "a.b" }
    };
    out({ type: "assistant", message: { content: [call] }, parent_tool_use_id: null });
    // The CLI asks its host before the tool runs; the Driver must refuse, never hang.
    out({
      type: "control_request",
      request_id: "cli-1",
      request: { subtype: "can_use_tool", tool_name: call.name }
    });
    answered = () => {
      out({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: '{"secret":1}' }]
            }
          ]
        },
        parent_tool_use_id: null
      });
      text(1, ["SUB"], "toolu_1");
      text(2, [" Done."]);
      result();
    };
    return;
  }
  text(0, ["Hel", "lo"]);
  out({
    type: "assistant",
    message: { content: [{ type: "text", text: "Hello" }] },
    parent_tool_use_id: null
  });
  result();
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${line}\n`);
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    out({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: {} }
    });
    if (message.request.subtype === "interrupt") {
      clearInterval(streaming);
      out({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }]
        },
        parent_tool_use_id: null
      });
      result({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming"
      });
    }
  } else if (message.type === "control_response") answered?.();
  else if (message.type === "user") turn();
}
clearInterval(streaming);
