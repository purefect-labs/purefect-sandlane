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
import { BrokerError } from "./contracts.js";
import {
  attachDockerContainer,
  startDockerExec,
  type DockerAttachChannel,
  type ExecChannelOptions
} from "./docker-attach.js";

export interface Engine {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  attach?(
    containerId: string,
    expiresAt: number,
    signal: AbortSignal
  ): Promise<DockerAttachChannel>;
  startExec?(
    execId: string,
    expiresAt: number,
    signal: AbortSignal,
    options?: ExecChannelOptions
  ): Promise<DockerAttachChannel>;
}

/** Local Unix socket only. No shell commands, redirects, environment-selected remote hosts. */
export class DockerEngine implements Engine {
  constructor(
    private readonly socketPath: string,
    private readonly apiVersion = "v1.45"
  ) {
    if (!socketPath.startsWith("/") || !/^v1\.\d+$/.test(apiVersion))
      throw new Error("Invalid Docker socket or API version");
  }

  /** Internal primitive, not an allocation authorization or proof of process termination. */
  startExec(
    execId: string,
    expiresAt: number,
    signal: AbortSignal,
    options?: ExecChannelOptions
  ): Promise<DockerAttachChannel> {
    return startDockerExec(this.socketPath, this.apiVersion, execId, expiresAt, signal, options);
  }

  /** Internal primitive, not an allocation authorization or proof of process termination. */
  attach(
    containerId: string,
    expiresAt: number,
    signal: AbortSignal
  ): Promise<DockerAttachChannel> {
    return attachDockerContainer(this.socketPath, this.apiVersion, containerId, expiresAt, signal);
  }

  request(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: `/${this.apiVersion}${path}`,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
          }
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              res.destroy();
              reject(new BrokerError("ENGINE_RESPONSE_LIMIT", 502, "Engine response too large"));
            } else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            if ((res.statusCode ?? 500) >= 400) {
              reject(
                new BrokerError(
                  "ENGINE_FAILURE",
                  res.statusCode === 404 ? 404 : 502,
                  `Docker returned ${res.statusCode}`
                )
              );
              return;
            }
            try {
              const data = Buffer.concat(chunks);
              resolve(chunks.length ? (JSON.parse(data.toString("utf8")) as unknown) : null);
            } catch {
              reject(new BrokerError("ENGINE_PROTOCOL", 502, "Invalid Docker response"));
            }
          });
        }
      );
      const timer = setTimeout(
        () => req.destroy(new Error("Docker request deadline exceeded")),
        15_000
      );
      req.once("close", () => clearTimeout(timer));
      req.once("error", reject);
      req.end(payload);
    });
  }
}
