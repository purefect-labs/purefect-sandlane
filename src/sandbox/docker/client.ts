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
import { BrokerError, object } from "./contracts.js";
import type { AllocationRef, RunSpec, RenewalSpec } from "./contracts.js";
import { openBrokerChannel } from "./channel-client.js";
import type { RunAuthorization } from "./managed-launch.js";
import { encodeInputs, INPUTS_CONTENT_TYPE } from "./session-inputs.js";
import {
  decodeOutputs,
  OUTPUTS_BODY_LIMIT,
  OUTPUTS_CONTENT_TYPE,
  type CollectedOutputs
} from "./session-outputs.js";

/** Reply limit of JSON operations. */
const JSON_REPLY_LIMIT = 2 * 1024 * 1024;

/** Scheduler-facing client. Only use over the same protected node-local Unix socket. */
export class BrokerClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string
  ) {
    if (!socketPath.startsWith("/") || token.length < 32)
      throw new Error("Protected local Broker connection required");
  }
  allocate(spec: RunSpec, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("allocate", spec, spec.schemaVersion, signal);
  }
  allocateManaged(
    spec: RunSpec,
    authorization: RunAuthorization,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.call("allocate", { spec, authorization }, 3, signal);
  }
  inspect(ref: AllocationRef, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("inspect", ref, 1, signal);
  }
  terminate(ref: AllocationRef, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("terminate", ref, 1, signal);
  }
  renew(spec: RenewalSpec, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("renew", spec, 2, signal);
  }
  status(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("status", {}, 1, signal);
  }
  /** Write input files into a session allocation before its channel opens (see putInputs). */
  putInputs(
    ref: AllocationRef,
    files: readonly { name: string; data: Uint8Array }[],
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.send("/v1/inputs", encodeInputs(ref, files), INPUTS_CONTENT_TYPE, signal);
  }
  /** Read the generated files of a running file-mode session (see getOutputs). */
  async getOutputs(ref: AllocationRef, signal?: AbortSignal): Promise<CollectedOutputs> {
    const reply = await this.exchange(
      "/v1/outputs",
      Buffer.from(JSON.stringify(ref)),
      "application/json",
      OUTPUTS_BODY_LIMIT,
      signal
    );
    if (reply.status === 200 && reply.type === OUTPUTS_CONTENT_TYPE)
      return decodeOutputs(reply.body);
    throw this.rejection(reply);
  }
  openChannel(ref: AllocationRef, expiresAt: number, signal: AbortSignal) {
    return openBrokerChannel(this.socketPath, this.token, ref, expiresAt, signal);
  }
  private call(
    operation: string,
    value: unknown,
    version = 1,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.send(
      `/v${version}/${operation}`,
      Buffer.from(JSON.stringify(value)),
      "application/json",
      signal
    );
  }
  private async send(
    path: string,
    body: Buffer,
    contentType: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const reply = await this.exchange(path, body, contentType, JSON_REPLY_LIMIT, signal);
    if (reply.status !== 200) throw this.rejection(reply);
    return object(JSON.parse(reply.body.toString("utf8")) as unknown);
  }
  /** The Broker's JSON error reply as an error (its code only). */
  private rejection(reply: { status: number; body: Buffer }): BrokerError {
    let code = "BROKER_FAILURE";
    try {
      code = String(object(JSON.parse(reply.body.toString("utf8")) as unknown).error ?? code);
    } catch {
      /* Not JSON: keep the generic code. */
    }
    return new BrokerError(
      code,
      reply.status === 200 ? 502 : reply.status,
      "Broker request rejected"
    );
  }
  private exchange(
    path: string,
    body: Buffer,
    contentType: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<{ status: number; type: string | undefined; body: Buffer }> {
    return new Promise((resolve, reject) => {
      // Cancellation ends waiting only: an already delivered mutation still requires reconciliation.
      signal?.throwIfAborted();
      const req = http.request(
        {
          socketPath: this.socketPath,
          signal,
          method: "POST",
          path,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": contentType,
            "Content-Length": body.length
          }
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) res.destroy(new Error("Broker response limit exceeded"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 502,
              type: res.headers["content-type"]?.split(";")[0]?.trim(),
              body: Buffer.concat(chunks, size)
            })
          );
        }
      );
      const deadline = setTimeout(
        () => req.destroy(new Error("Broker deadline exceeded; inspect allocation before retry")),
        60_000
      );
      req.once("close", () => clearTimeout(deadline));
      req.once("error", reject);
      req.end(body);
    });
  }
}
