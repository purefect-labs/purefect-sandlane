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
import type http from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import type { SandboxBroker } from "./lifecycle.js";
import type { DockerAttachChannel } from "./docker-attach.js";
import { CHANNEL_ALLOCATION_HEADER, CHANNEL_PROTOCOL } from "./channel-client.js";

const LIMIT = 4 * 1024 * 1024;

function rejectUpgrade(socket: Duplex, status: "401 Unauthorized" | "400 Bad Request"): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy()
  );
}

function write(socket: Duplex, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.write(bytes, error => (error ? reject(error) : resolve()))
  );
}

/** Attach only to the protected Broker Unix listener. This is not a general exec or Docker proxy. */
export function installBrokerChannels(
  server: http.Server,
  broker: SandboxBroker,
  token: string
): void {
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set<Duplex>();
  server.on("close", () => {
    for (const socket of active) socket.destroy();
  });
  server.on("upgrade", (request, socket, head) => {
    // Pause before asynchronous authorization so no protocol bytes can bypass backpressure.
    socket.pause();
    socket.on("error", () => {});
    const actual = Buffer.from(request.headers.authorization ?? "");
    const names = request.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map(name => name.toLowerCase());
    if (
      names.filter(name => name === "authorization").length !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    if (
      request.method !== "POST" ||
      request.url !== "/v2/channel" ||
      request.headers.upgrade !== CHANNEL_PROTOCOL ||
      request.headers.origin !== undefined ||
      request.headers["transfer-encoding"] !== undefined ||
      request.headers["content-length"] !== "0" ||
      names.filter(name => name === CHANNEL_ALLOCATION_HEADER).length !== 1 ||
      head.length ||
      active.size >= 64
    ) {
      rejectUpgrade(socket, "400 Bad Request");
      return;
    }
    const encoded = request.headers[CHANNEL_ALLOCATION_HEADER];
    let ref: unknown;
    try {
      if (typeof encoded !== "string" || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw Error();
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw Error();
      ref = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      rejectUpgrade(socket, "400 Bad Request");
      return;
    }
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    active.add(socket);
    void (async () => {
      let channel: DockerAttachChannel | undefined;
      try {
        channel = await broker.openChannel(ref, abort.signal);
        if (abort.signal.aborted) throw Error();
        await write(
          socket,
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${CHANNEL_PROTOCOL}\r\n\r\n`
          )
        );
        const attached = channel;
        let inputBytes = 0,
          outputBytes = 0;
        await Promise.all([
          (async () => {
            try {
              for await (const chunk of socket) {
                const bytes = Buffer.from(chunk as Uint8Array);
                inputBytes += bytes.length;
                if (inputBytes > LIMIT) throw Error();
                await attached.write(bytes);
              }
            } finally {
              // A peer may half-close stdin without producing a socket close event.
              // End both pumps explicitly so cleanup cannot wait forever for CLI stdout.
              abort.abort();
              attached.close();
              socket.destroy();
            }
          })(),
          (async () => {
            for await (const bytes of attached.output) {
              outputBytes += bytes.length;
              if (outputBytes > LIMIT) throw Error();
              await write(socket, bytes);
            }
            socket.end();
          })()
        ]);
      } catch {
        // No Docker details, stderr, credentials or arbitrary protocol errors cross this boundary.
      } finally {
        abort.abort();
        channel?.close();
        socket.destroy();
        active.delete(socket);
        // EOF only initiates reconciliation; termination acknowledgement is still a separate API result.
        if (channel) await broker.terminate(ref).catch(() => {});
      }
    })();
  });
}
