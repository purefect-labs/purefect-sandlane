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
import { DockerOutputDecoder } from "./docker-output.js";

/** Byte-channel closure is NOT evidence that the CLI or container has stopped. */
export interface DockerAttachChannel {
  readonly output: AsyncIterable<Buffer>;
  write(frame: Buffer): Promise<void>;
  /** End the process's stdin (half-close) after the last write; output keeps flowing. */
  end?(): Promise<void>;
  close(): void;
}

/** Broker-internal only. Caller must authorize and resolve the allocation to its exact container ID. */
export function attachDockerContainer(
  socketPath: string,
  apiVersion: string,
  containerId: string,
  expiresAt: number,
  signal: AbortSignal
): Promise<DockerAttachChannel> {
  return openDockerChannel(socketPath, apiVersion, containerId, expiresAt, signal, false);
}

/** Options of an exec channel. */
export interface ExecChannelOptions {
  /** Output byte limit per stream instead of the default 4 MiB (see DockerOutputDecoder). */
  readonly maxOutputBytes?: number;
}

/** An exec process gets fresh per-Run environment inside an already owned session container. */
export function startDockerExec(
  socketPath: string,
  apiVersion: string,
  execId: string,
  expiresAt: number,
  signal: AbortSignal,
  options: ExecChannelOptions = {}
): Promise<DockerAttachChannel> {
  return openDockerChannel(
    socketPath,
    apiVersion,
    execId,
    expiresAt,
    signal,
    true,
    options.maxOutputBytes
  );
}

function openDockerChannel(
  socketPath: string,
  apiVersion: string,
  containerId: string,
  expiresAt: number,
  signal: AbortSignal,
  exec: boolean,
  maxOutputBytes?: number
): Promise<DockerAttachChannel> {
  if (
    !socketPath.startsWith("/") ||
    !/^v1\.\d+$/.test(apiVersion) ||
    !/^[a-f0-9]{64}$/.test(containerId) ||
    (maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 30 * 60_000
  ) {
    return Promise.reject(new Error("Invalid Docker attach binding"));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Docker attach cancelled"));
      return;
    }
    let upgraded = false;
    const payload = exec ? JSON.stringify({ Detach: false, Tty: false }) : "";
    const req = http.request({
      socketPath,
      method: "POST",
      path: exec
        ? `/${apiVersion}/exec/${containerId}/start`
        : `/${apiVersion}/containers/${containerId}/attach?stream=true&stdin=true&stdout=true&stderr=true&logs=false`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "tcp",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload))
      }
    });
    const abort = () => req.destroy(new Error("Docker attach cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => req.destroy(new Error("Docker attach deadline exceeded")),
      Math.min(5_000, expiresAt - Date.now())
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    req.once("error", () => {
      cleanup();
      reject(new Error("Docker attach failed"));
    });
    req.once("close", () => {
      if (!upgraded) cleanup();
    });
    req.once("response", res => {
      res.destroy();
      cleanup();
      reject(new Error("Docker attach upgrade required"));
    });
    req.once("upgrade", (res, socket, head) => {
      // Ownership of cancellation and deadlines moves from the HTTP request to the channel.
      upgraded = true;
      cleanup();
      if (
        res.statusCode !== 101 ||
        res.headers.upgrade?.toLowerCase() !== "tcp" ||
        signal.aborted ||
        expiresAt <= Date.now()
      ) {
        socket.destroy();
        reject(new Error("Docker attach upgrade rejected"));
        return;
      }
      const channel = new SocketAttachChannel(socket, expiresAt, signal, maxOutputBytes);
      // The upgrade packet may already contain CLI output. Return it to the readable stream.
      if (head.length) socket.unshift(head);
      resolve(channel);
    });
    req.end(payload);
  });
}

/** One reader and one pending writer; socket backpressure bounds memory for slow consumers. */
class SocketAttachChannel implements DockerAttachChannel {
  readonly output: AsyncIterable<Buffer>;
  private reading = false;
  private writing = false;
  private closed = false;
  // Normal close may leave buffered stdout to drain. Local interruption invalidates that
  // read instead; these flags deliberately describe different facts.
  private interrupted = false;
  private readonly timer: NodeJS.Timeout;
  private readonly abort = () => this.close();

  constructor(
    private readonly socket: Duplex,
    expiresAt: number,
    private readonly signal: AbortSignal,
    private readonly maxOutputBytes?: number
  ) {
    // Always consume errors, including before the caller starts iterating.
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
    if (this.reading) throw new Error("Docker attach reader already consumed");
    this.reading = true;
    const decoder = new DockerOutputDecoder(this.maxOutputBytes);
    try {
      if (this.interrupted || this.socket.errored) throw new Error("Docker attach closed");
      for await (const chunk of this.socket) {
        yield* decoder.push(Buffer.from(chunk as Uint8Array));
      }
      if (this.interrupted) throw new Error("Docker attach closed");
      decoder.finish();
    } catch {
      throw new Error("Docker attach output failed");
    } finally {
      this.close();
    }
  }

  async write(frame: Buffer): Promise<void> {
    if (this.closed || !this.socket.writable) throw new Error("Docker attach closed");
    if (this.writing || frame.length > 128 * 1024) throw new Error("Docker attach input limit");
    this.writing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        // Snapshot caller-owned bytes and wait for the socket write before allowing another.
        this.socket.write(Buffer.from(frame), error =>
          error ? reject(new Error("Docker attach input failed")) : resolve()
        );
      });
    } finally {
      this.writing = false;
    }
  }

  /** Docker closes an exec's stdin when the hijacked connection's write side ends. */
  async end(): Promise<void> {
    if (this.closed || this.writing || !this.socket.writable)
      throw new Error("Docker attach closed");
    await new Promise<void>(resolve => this.socket.end(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.interrupted = true;
    this.closed = true;
    this.cleanup();
    this.socket.destroy();
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
  }
}
