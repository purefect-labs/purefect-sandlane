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

import { randomBytes } from "node:crypto";
import { ResponsesProvider } from "../dist/gateway/model/responses-provider.js";
import { MessagesProvider } from "../dist/gateway/model/messages-provider.js";
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";
import { parseMessagesRequest } from "../dist/gateway/model/messages-request.js";

const tool = "compatibility_echo";
const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false
};

/** Two real streamed calls through the production request/response validators. No business
 * tools, fallback, retries or raw output logging. This is a provider probe, not a CLI E2E test.
 * The injectable transport is used only by deterministic offline tests. */
export async function probeModel(profile, secret, send) {
  if (
    !["responses", "anthropic-messages"].includes(profile.wire) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(profile.model) ||
    (profile.auth !== undefined && !["x-api-key", "bearer", "both"].includes(profile.auth))
  )
    throw Error("INVALID_PROBE_PROFILE");
  const max = profile.maxOutputTokens ?? 2048;
  if (!Number.isSafeInteger(max) || max < 256 || max > 8192) throw Error("INVALID_PROBE_LIMIT");
  const nonce = randomBytes(12).toString("hex");
  const prompt =
    "Compatibility test. Call compatibility_echo exactly once with value " +
    nonce +
    ". After receiving the tool result, reply with exactly that value. Do not use other tools.";
  const signal = AbortSignal.timeout(120_000);
  let requests = 0;
  let inputTokens = 0,
    outputTokens = 0;
  const account = result => {
    requests++;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    return result;
  };
  const checkTool = (name, raw) => {
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (name !== tool || !args || Object.keys(args).length !== 1 || args.value !== nonce)
      throw Error("PROBE_TOOL_MISMATCH");
  };
  let text;
  if (profile.wire === "responses") {
    const provider = new ResponsesProvider(profile.baseUri, send);
    const tools = [
      {
        type: "function",
        name: tool,
        description: "Return the supplied value.",
        parameters: schema
      }
    ];
    const invoke = async input =>
      account(
        await provider.invoke(
          parseResponsesRequest(
            { model: "probe", stream: true, input, tools, tool_choice: "auto" },
            [tool],
            max
          ),
          profile.model,
          secret,
          [],
          signal
        )
      );
    const first = await invoke(prompt);
    const output = first.events.find(e => e.type === "response.completed")?.response?.output;
    const calls = output?.filter(item => item.type === "function_call") ?? [];
    if (calls.length !== 1) throw Error("PROBE_TOOL_MISSING");
    checkTool(calls[0].name, calls[0].arguments);
    const second = await invoke([
      { role: "user", content: prompt },
      ...output,
      { type: "function_call_output", call_id: calls[0].call_id, output: nonce }
    ]);
    const final = second.events.find(e => e.type === "response.completed")?.response?.output ?? [];
    if (final.some(item => item.type === "function_call")) throw Error("PROBE_UNEXPECTED_TOOL");
    text = final
      .filter(item => item.type === "message")
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === "output_text")
      .map(part => part.text)
      .join("");
  } else {
    const provider = new MessagesProvider(profile.baseUri, send, profile.auth ?? "x-api-key");
    const tools = [{ name: tool, description: "Return the supplied value.", input_schema: schema }];
    const invoke = async messages =>
      account(
        await provider.invoke(
          parseMessagesRequest(
            { model: "probe", stream: true, max_tokens: max, messages, tools },
            { betaQuery: false, version: "2023-06-01" },
            [tool],
            max
          ),
          profile.model,
          secret,
          [],
          signal
        )
      );
    const first = await invoke([{ role: "user", content: prompt }]);
    const content = messageContent(first.events);
    const calls = content.filter(block => block.type === "tool_use");
    if (calls.length !== 1) throw Error("PROBE_TOOL_MISSING");
    checkTool(calls[0].name, calls[0].input);
    const second = await invoke([
      { role: "user", content: prompt },
      { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: nonce }] }
    ]);
    const final = messageContent(second.events);
    if (final.some(block => block.type === "tool_use")) throw Error("PROBE_UNEXPECTED_TOOL");
    text = final
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
  }
  if (text?.trim() !== nonce) throw Error("PROBE_TEXT_MISMATCH");
  return { requests, toolCalls: 1, inputTokens, outputTokens };
}

function messageContent(events) {
  const blocks = new Map();
  const inputs = new Map();
  for (const event of events) {
    const frame = JSON.parse(event.data);
    if (frame.type === "content_block_start")
      blocks.set(frame.index, structuredClone(frame.content_block));
    if (frame.type === "content_block_delta") {
      const block = blocks.get(frame.index);
      if (!block) throw Error("PROBE_INVALID_STREAM");
      const delta = frame.delta;
      if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
      else if (delta.type === "input_json_delta")
        inputs.set(frame.index, (inputs.get(frame.index) ?? "") + delta.partial_json);
      else if (delta.type === "thinking_delta")
        block.thinking = (block.thinking ?? "") + delta.thinking;
      else if (delta.type === "signature_delta")
        block.signature = (block.signature ?? "") + delta.signature;
    }
  }
  for (const [index, input] of inputs) blocks.get(index).input = JSON.parse(input);
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
}
