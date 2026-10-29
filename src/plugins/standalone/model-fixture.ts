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
import { randomBytes } from "node:crypto";

/** HTTPS fixture upstream. The nonce is generated here, not supplied by the CLI's prompt. */
export function createDemoModel(
  tls: { key: Buffer; cert: Buffer },
  apiKey: string,
  auth: "x-api-key" | "bearer" | "both" = "x-api-key"
) {
  const nonce = randomBytes(16).toString("hex");
  let requests = 0,
    verified = false;
  const server = https.createServer(tls, async (req, res) => {
    try {
      if (
        req.url !== "/v1/messages" ||
        req.method !== "POST" ||
        (auth !== "bearer" && req.headers["x-api-key"] !== apiKey) ||
        (auth !== "x-api-key" && req.headers.authorization !== `Bearer ${apiKey}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body.stream || !Array.isArray(body.messages)) throw new Error("INVALID_FIXTURE_REQUEST");
      requests++;
      const result = body.messages
        .flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
        .find((v: { type?: string }) => v.type === "tool_result");
      if (result && !JSON.stringify(result).includes(nonce))
        throw new Error("FIXTURE_NONCE_MISMATCH");
      verified ||= !!result;
      const content = result
        ? { type: "text", text: "" }
        : { type: "tool_use", id: "toolu_demo", name: "mcp__demo__demo_echo", input: {} };
      const frame = (type: string, data: Record<string, unknown>) =>
        res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      frame("message_start", {
        message: {
          id: "msg_demo",
          type: "message",
          role: "assistant",
          model: "demo",
          content: [],
          usage: { input_tokens: 8, output_tokens: 0 }
        }
      });
      frame("content_block_start", { index: 0, content_block: content });
      frame("content_block_delta", {
        index: 0,
        delta: result
          ? { type: "text_delta", text: "Demo verified: " + nonce }
          : { type: "input_json_delta", partial_json: JSON.stringify({ nonce }) }
      });
      frame("content_block_stop", { index: 0 });
      frame("message_delta", {
        delta: { stop_reason: result ? "end_turn" : "tool_use" },
        usage: { output_tokens: 8 }
      });
      frame("message_stop", {});
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  return { server, evidence: () => ({ requests, verified, nonce }) };
}
