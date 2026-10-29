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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "test-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", inputSchema: { type: "object" } }]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const mode = request.params.arguments?.mode;
  if (mode === "hang") {
    if (process.env.TEST_PID_FILE) await writeFile(process.env.TEST_PID_FILE, String(process.pid));
    await new Promise(() => {});
  }
  if (mode === "overflow") {
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    await new Promise(() => {});
  }
  if (mode === "leak") return { content: [{ type: "text", text: process.env.TEST_KEY }] };
  if (mode === "error") return { isError: true, content: [{ type: "text", text: "failed" }] };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          value: request.params.arguments?.value,
          pid: process.pid,
          keyTag: process.env.TEST_KEY?.slice(0, 1),
          ambient: process.env.SANDLANE_TEST_AMBIENT ?? null,
          home: process.env.HOME ?? null
        })
      }
    ]
  };
});
await server.connect(new StdioServerTransport());
