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
import http from "node:http";
import type { Duplex } from "node:stream";
import { parseRef, type AllocationRef } from "./contracts.js";
import type { DockerAttachChannel } from "./docker-attach.js";

/** HTTP upgrade protocol of the Broker byte channel, and the header naming its allocation. */
export const CHANNEL_PROTOCOL = "sandlane-stdio-v1";
export const CHANNEL_ALLOCATION_HEADER = "x-sandlane-allocation";

/** Protected Broker socket only. Callers cannot select a Docker ID, command or network destination. */
export function openBrokerChannel(
  socketPath: string,
  token: string,
  reference: AllocationRef,
  expiresAt: number,
  signal: AbortSignal
): Promise<DockerAttachChannel> {
  const ref = parseRef(reference);
  if (
    !socketPath.startsWith("/") ||
    token.length < 32 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 30 * 60000
  )
    return Promise.reject(new Error("BROKER_CHANNEL_CONFIGURATION"));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("BROKER_CHANNEL_CANCELLED"));
      return;
    }
    const request = http.request({
      socketPath,
      method: "POST",
      path: "/v2/channel",
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: "Upgrade",
        Upgrade: CHANNEL_PROTOCOL,
        "Content-Length": "0",
        [CHANNEL_ALLOCATION_HEADER]: Buffer.from(JSON.stringify(ref)).toString("base64url")
      }
    });
    const abort = () => request.destroy(new Error("BROKER_CHANNEL_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(5000, expiresAt - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    request.once("error", () => {
      cleanup();
      reject(new Error("BROKER_CHANNEL_UNAVAILABLE"));
    });
    request.once("response", response => {
      response.destroy();
      cleanup();
      reject(new Error("BROKER_CHANNEL_REJECTED"));
    });
    request.once("upgrade", (response, socket, head) => {
      cleanup();
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade !== CHANNEL_PROTOCOL ||
        signal.aborted ||
        expiresAt <= Date.now()
      ) {
        socket.destroy();
        reject(new Error("BROKER_CHANNEL_REJECTED"));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(new BrokerSocketChannel(socket, expiresAt, signal));
    });
    request.end();
  });
}

class BrokerSocketChannel implements DockerAttachChannel {
  readonly output: AsyncIterable<Buffer>;
  private closed = false;
  private interrupted = false;
  private reading = false;
  private writing = false;
  private inputBytes = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly abort = () => this.close();

  constructor(
    private readonly socket: Duplex,
    expiresAt: number,
    private readonly signal: AbortSignal
  ) {
    socket.on("error", () => {});
    socket.once("close", () => {
      this.closed = true;
      this.cleanup();
    });
    this.timer = setTimeout(() => this.close(), Math.max(0, expiresAt - Date.now()));
    signal.addEventListener("abort", this.abort, { once: true });
    this.output = { [Symbol.asyncIterator]: () => this.read() };
    if (signal.aborted) this.close();
  }

  private async *read(): AsyncGenerator<Buffer> {
    if (this.reading) throw new Error("BROKER_CHANNEL_READER_USED");
    this.reading = true;
    let total = 0;
    try {
      if (this.interrupted || this.socket.errored) throw Error();
      for await (const chunk of this.socket) {
        const bytes = Buffer.from(chunk as Uint8Array);
        total += bytes.length;
        if (total > 4 * 1024 * 1024) throw Error();
        yield bytes;
      }
      if (this.interrupted) throw Error();
    } catch {
      throw new Error("BROKER_CHANNEL_OUTPUT_UNAVAILABLE");
    } finally {
      this.close();
    }
  }

  async write(frame: Buffer): Promise<void> {
    if (
      this.closed ||
      this.writing ||
      frame.length > 128 * 1024 ||
      this.inputBytes + frame.length > 4 * 1024 * 1024
    )
      throw new Error("BROKER_CHANNEL_INPUT_LIMIT");
    this.writing = true;
    this.inputBytes += frame.length;
    try {
      await new Promise<void>((resolve, reject) =>
        this.socket.write(Buffer.from(frame), error =>
          error ? reject(new Error("BROKER_CHANNEL_INPUT_UNAVAILABLE")) : resolve()
        )
      );
    } finally {
      this.writing = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupted = true;
    this.cleanup();
    this.socket.destroy();
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
  }
}
