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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request } from "node:https";
import { once } from "node:events";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const LIMIT = 1024 * 1024;

/** Bounded POST/DELETE transport. No redirects, ambient cookies, GET event stream or retry. */
export function mcpFetch(endpoint: string, signal: AbortSignal, ca?: string): FetchLike {
  let total = 0;
  return async (url, init) => {
    if (String(url) !== endpoint) throw Error("MCP_ENDPOINT_REJECTED");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (!["POST", "DELETE"].includes(init?.method ?? "")) throw Error("MCP_METHOD_REJECTED");
    const body = init?.body;
    if (body !== undefined && (typeof body !== "string" || Buffer.byteLength(body) > LIMIT))
      throw Error("MCP_REQUEST_LIMIT");
    const stop = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    stop.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        endpoint,
        {
          method: init!.method!,
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: stop,
          ...(ca ? { ca } : {}),
          rejectUnauthorized: true
        },
        res => {
          if ((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400) {
            res.destroy();
            reject(Error("MCP_REDIRECT_REJECTED"));
            return;
          }
          let size = 0;
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          const status = res.statusCode ?? 500;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                total += chunk.length;
                if (size > LIMIT || total > 4 * LIMIT) {
                  res.destroy(Error("MCP_RESPONSE_LIMIT"));
                  return;
                }
                controller.enqueue(chunk);
                if ((controller.desiredSize ?? 0) <= 0) res.pause();
              });
              res.on("error", () => controller.error(Error("MCP_RESPONSE_FAILED")));
              res.on("end", () => controller.close());
            },
            pull() {
              res.resume();
            },
            cancel() {
              res.destroy();
            }
          });
          if ([204, 205, 304].includes(status)) {
            void stream.cancel();
            resolve(new Response(null, { status, headers }));
          } else resolve(new Response(stream, { status, headers }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}

/** Trusted installed programs only. Exact environment, no shell, fresh process per call.
 * POSIX process groups stop descendants; deployment still owns filesystem/network isolation. */
export class ManagedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  #process?: ChildProcessWithoutNullStreams;
  #closed?: Promise<void>;
  #exit?: Promise<void>;
  #buffer = new ReadBuffer({ maxBufferSize: LIMIT });
  constructor(
    private readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    }
  ) {}
  async start(): Promise<void> {
    if (process.platform === "win32") throw Error("MCP_STDIO_REQUIRES_POSIX");
    if (this.#process || this.#closed) throw Error("MCP_TRANSPORT_CLOSED");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      detached: true,
      stdio: "pipe"
    });
    this.#process = child;
    this.#exit = new Promise(resolve =>
      child.once("close", () => {
        this.onclose?.();
        resolve();
      })
    );
    child.on("error", () => this.onerror?.(Error("MCP_PROCESS_FAILED")));
    let bytes = 0,
      messages = 0;
    const fail = () => {
      this.onerror?.(Error("MCP_STDIO_LIMIT_OR_PROTOCOL"));
      void this.close().catch(() => {});
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * LIMIT) {
        fail();
        return;
      }
      try {
        this.#buffer.append(chunk);
        for (;;) {
          const message = this.#buffer.readMessage();
          if (!message) break;
          if (++messages > 256) throw Error("MCP_MESSAGE_LIMIT");
          this.onmessage?.(message);
        }
      } catch {
        fail();
      }
    });
    // Never inherit stderr: programs may print credentials and business payloads.
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if ((errorBytes += chunk.length) > LIMIT) fail();
    });
    child.stdin.on("error", () => this.onerror?.(Error("MCP_STDIN_FAILED")));
    await once(child, "spawn");
  }
  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    const child = this.#process;
    if (!child || this.#closed) throw Error("MCP_TRANSPORT_CLOSED");
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > LIMIT) throw Error("MCP_REQUEST_LIMIT");
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(data, error => (error ? reject(Error("MCP_SEND_FAILED")) : resolve()))
    );
  }
  close(): Promise<void> {
    return (this.#closed ??= this.#close());
  }
  async #close(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw Error("MCP_CLEANUP_FAILED");
        }
    };
    kill("SIGTERM");
    // Always kill the process group after grace, even if the direct child exited first.
    await new Promise(resolve => setTimeout(resolve, 100));
    kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("MCP_CLEANUP_FAILED")), 2000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      this.#buffer.clear();
    }
  }
}
