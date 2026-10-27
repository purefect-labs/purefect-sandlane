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
import { timingSafeEqual } from "node:crypto";
import { chmod, chown } from "node:fs/promises";
import { requireSocketDirectory } from "./socket-permissions.js";
import type { SandboxBroker } from "./lifecycle.js";
import { BrokerError, object } from "./contracts.js";
import { installBrokerChannels } from "./channel-server.js";
import { INPUTS_BODY_LIMIT, INPUTS_CONTENT_TYPE } from "./session-inputs.js";
import { OUTPUTS_CONTENT_TYPE } from "./session-outputs.js";

/** Binary operation: the raw body (at most `limit` bytes) instead of JSON. */
export interface UploadOperation {
  readonly limit: number;
  handle(body: Buffer): Promise<unknown>;
}

/** JSON request, binary reply (application/octet-stream): the reply's parts, sent as is. */
export type DownloadOperation = (value: unknown) => Promise<readonly Buffer[]>;

/** Uploads and downloads buffered at once; each may hold tens of MiB, so further ones are
 * refused (429). */
const MAX_UPLOADS = 2;
/** JSON request body limit of control commands and downloads. */
const CONTROL_BODY_LIMIT = 32000;

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit)
    throw new BrokerError("BODY_LIMIT", 413, "Request too large");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) throw new BrokerError("BODY_LIMIT", 413, "Request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/** Local protected Unix socket. This is not a network-facing Docker proxy. */
export function createBrokerServer(broker: SandboxBroker, token: string): http.Server {
  const server = createJsonControlServer(
    {
      "/v2/allocate": value => {
        if (object(value).schemaVersion !== 2)
          throw new BrokerError("VERSION_MISMATCH", 409, "Allocation protocol mismatch");
        return broker.allocate(value);
      },
      "/v3/allocate": value => {
        const authorization = object(object(value).authorization);
        if (
          [authorization.model, authorization.tool].some(
            capability => object(capability).value === token
          )
        )
          throw new BrokerError(
            "CREDENTIAL_ROLE_CONFLICT",
            400,
            "Node credential cannot become a Run capability"
          );
        return broker.allocateManaged(value);
      },
      "/v1/inspect": value => broker.inspect(value),
      "/v1/terminate": value => broker.terminate(value),
      "/v2/renew": value => broker.renew(value),
      "/v1/status": async value => {
        emptyBody(value);
        return broker.status();
      }
    },
    token,
    { "/v1/inputs": { limit: INPUTS_BODY_LIMIT, handle: body => broker.putInputs(body) } },
    { "/v1/outputs": value => broker.getOutputs(value) }
  );
  installBrokerChannels(server, broker, token);
  return server;
}

export function emptyBody(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
    throw new BrokerError("INVALID_SPEC", 400, "Expected an empty object");
  }
}

async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new BrokerError("INVALID_JSON", 400, "Invalid JSON");
  }
}

/** JSON operations, plus optional binary uploads (binary body, JSON reply) and downloads (JSON
 * body, binary reply) behind the same service authentication; every error reply is JSON. */
export function createJsonControlServer(
  operations: Record<string, (value: unknown) => Promise<unknown>>,
  token: string,
  uploads: Record<string, UploadOperation> = {},
  downloads: Record<string, DownloadOperation> = {}
): http.Server {
  if (Buffer.byteLength(token) < 32)
    throw new Error("Broker service credential must have at least 32 bytes");
  const expected = Buffer.from(`Bearer ${token}`);
  let uploading = 0;
  return http.createServer(
    { requestTimeout: 20_000, headersTimeout: 5_000, maxHeaderSize: 8_192 },
    async (req, res) => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      const actual = Buffer.from(req.headers.authorization || "");
      const authorizationCount = req.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "authorization"
      ).length;
      if (
        authorizationCount !== 1 ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        send(401, { error: "UNAUTHORIZED" });
        return;
      }
      if (req.headers.origin !== undefined) {
        send(403, { error: "ORIGIN_NOT_ALLOWED" });
        return;
      }
      const operation = Object.hasOwn(operations, req.url || "")
        ? operations[req.url || ""]
        : undefined;
      const upload = Object.hasOwn(uploads, req.url || "") ? uploads[req.url || ""] : undefined;
      const download = Object.hasOwn(downloads, req.url || "")
        ? downloads[req.url || ""]
        : undefined;
      if (req.method !== "POST" || (!operation && !upload && !download)) {
        send(404, { error: "NOT_FOUND" });
        return;
      }
      if (download) {
        let counted = false;
        try {
          if (req.headers["content-type"] !== "application/json")
            throw new BrokerError("CONTENT_TYPE", 415, "JSON required");
          if (uploading >= MAX_UPLOADS) throw new BrokerError("BUSY", 429, "Too many transfers");
          uploading++;
          counted = true;
          const parts = await download(await readJson(req, CONTROL_BODY_LIMIT));
          res.writeHead(200, {
            "content-type": OUTPUTS_CONTENT_TYPE,
            "content-length": String(parts.reduce((sum, part) => sum + part.length, 0)),
            "cache-control": "no-store"
          });
          for (const part of parts) res.write(part);
          res.end();
        } catch (error) {
          res.setHeader("connection", "close");
          send(error instanceof BrokerError ? error.status : 503, {
            error: error instanceof BrokerError ? error.code : "BROKER_UNAVAILABLE"
          });
        } finally {
          if (counted) uploading--;
        }
        return;
      }
      if (upload) {
        let counted = false;
        try {
          if (req.headers["content-type"] !== INPUTS_CONTENT_TYPE)
            throw new BrokerError("CONTENT_TYPE", 415, "Binary body required");
          if (uploading >= MAX_UPLOADS) throw new BrokerError("BUSY", 429, "Too many uploads");
          uploading++;
          counted = true;
          send(200, await upload.handle(await readBody(req, upload.limit)));
        } catch (error) {
          // The body may be left unread: never reuse this connection for another request.
          res.setHeader("connection", "close");
          send(error instanceof BrokerError ? error.status : 503, {
            error: error instanceof BrokerError ? error.code : "BROKER_UNAVAILABLE"
          });
        } finally {
          if (counted) uploading--;
        }
        return;
      }
      try {
        if (!operation) throw new BrokerError("NOT_FOUND", 404, "Unknown operation");
        if (req.headers["content-type"] !== "application/json")
          throw new BrokerError("CONTENT_TYPE", 415, "JSON required");
        let size = 0;
        // Allocation JSON can contain an escaped versioned prompt envelope. Small control
        // commands keep their original bound; decoded prompt/context limits apply separately.
        const bodyLimit = ["/v2/allocate", "/v3/allocate"].includes(req.url || "") ? 128000 : 32000;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > bodyLimit) throw new BrokerError("BODY_LIMIT", 413, "Request too large");
          chunks.push(buffer);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          throw new BrokerError("INVALID_JSON", 400, "Invalid JSON");
        }
        send(200, await operation(input));
      } catch (error) {
        send(error instanceof BrokerError ? error.status : 503, {
          error: error instanceof BrokerError ? error.code : "BROKER_UNAVAILABLE"
        });
      }
    }
  );
}

export async function listenUnix(
  server: http.Server,
  socketPath: string,
  groupId?: number
): Promise<void> {
  await requireSocketDirectory(socketPath, groupId);
  const groupMode = groupId !== undefined;
  // Never unlink an existing socket: it might belong to another active Broker.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    // Host and Broker keep separately owned 0600 token files with the same service secret.
    // Only this control socket is shared; the group must not grant access to the Docker socket.
    if (groupMode) await chown(socketPath, process.getuid!(), groupId);
    await chmod(socketPath, groupMode ? 0o660 : 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
}
