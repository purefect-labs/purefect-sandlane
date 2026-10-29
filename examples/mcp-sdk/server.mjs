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
import https from "node:https";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { tools, customerSdk } from "./tools.mjs";

// Minimal, stateless proof of integration. Production deployment additionally needs the
// external hard timeout/restart and resource policies described in README.md.
export function createSdkServer(
  tls,
  principals,
  { invoke = customerSdk, observe = () => {} } = {}
) {
  const check = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
  let active = 0;
  return https.createServer(tls, async (req, res) => {
    observe(req.method);
    const principal = principals.get(req.headers.authorization);
    if (!principal || req.headers.origin || req.url !== "/mcp") {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (active >= 4) {
      res.writeHead(503).end();
      return;
    }
    active++;
    const mcp = new Server(
      { name: "sdk-template", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools
        .filter(t => principal.tools.includes(t.remoteName))
        .map(t => ({
          name: t.remoteName,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly }
        }))
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const tool = tools.find(t => t.remoteName === request.params.name);
      if (!tool || !principal.tools.includes(tool.remoteName))
        return { isError: true, structuredContent: { error: "ACCESS_DENIED" }, content: [] };
      if (!check(request.params.arguments).valid)
        return { isError: true, structuredContent: { error: "INVALID_ARGUMENTS" }, content: [] };
      try {
        return await invoke(principal, request.params.arguments);
      } catch {
        return { isError: true, content: [{ type: "text", text: "SDK_CALL_FAILED" }] };
      }
    });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 40000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.end();
    } finally {
      await mcp.close();
      active--;
    }
  });
}
