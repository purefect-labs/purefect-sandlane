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
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";

async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error("condition timed out");
}

test("Codex gets page actions as MCP tools only: no dynamic tools, reverse tool calls refused", async t => {
  const messages = [];
  let observer;
  const emit = value => observer.stdout(Buffer.from(JSON.stringify(value) + "\n"));
  const adapter = new CodexRunAdapter({
    workspace: "/workspace",
    transport: {
      async start(value) {
        observer = value;
      },
      async write(bytes) {
        const message = JSON.parse(bytes);
        messages.push(message);
        if (message.method === "initialize") emit({ id: message.id, result: {} });
        if (message.method === "thread/start")
          emit({ id: message.id, result: { thread: { id: "thread-1" } } });
        if (message.method === "turn/start")
          emit({ id: message.id, result: { turn: { id: "turn-1" } } });
      },
      async stop() {
        return { state: "exited", code: 0, signal: null };
      }
    }
  });
  const events = [];
  adapter.on("event", event => events.push(event));
  const ui_context = {
    workspace_action_protocol: "purefect-workspace-interaction/1",
    surface: "console",
    operations: ["describe"],
    interaction: 1
  };
  const running = adapter.execute({
    runId: "r1",
    expiresAt: Date.now() + 10000,
    promptFormat: "workspace-context-v1",
    prompt: JSON.stringify({ version: 1, prompt: "Which page?", ui_context })
  });
  t.after(async () => {
    await adapter.cancel();
    await running;
  });
  await until(() => messages.some(message => message.method === "turn/start"));
  assert.deepEqual(messages.find(m => m.method === "initialize").params.capabilities, {});
  assert.equal("dynamicTools" in messages.find(m => m.method === "thread/start").params, false);
  // A dynamic tool call (older thread or forged) is answered with an error, never relayed.
  emit({
    id: 80,
    method: "item/tool/call",
    params: { threadId: "thread-1", callId: "call-80", tool: "workspace_action", arguments: {} }
  });
  await until(() => messages.some(m => m.id === 80));
  assert.equal(messages.find(m => m.id === 80).error.code, -32601);
  emit({ method: "item/agentMessage/delta", params: { delta: "done" } });
  emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  await running;
  assert.deepEqual(
    events.map(e => e.type),
    ["message.delta", "run.completed"]
  );
});
