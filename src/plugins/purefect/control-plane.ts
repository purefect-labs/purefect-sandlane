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
import { isObject } from "../../common/json.js";
import {
  ControlPlaneError,
  type ClaimRequest,
  type ClaimedLease,
  type CompleteRequest,
  type CompleteResult,
  type ControlPlane,
  type ControlTool,
  type OutputRequest,
  type OutputResult,
  type SyncRequest,
  type SyncResponse
} from "../../spi/control-plane.js";
import {
  parseClaimResponse,
  parseCompleteResponse,
  faultError,
  parseOutputResponse,
  parseProposeResponse,
  parseSyncResponse,
  readLease,
  type ProposeRequest,
  type ProposeResult
} from "./contract.js";
import { taskDelegationTools } from "./task-delegation.js";
import { WORKSPACE_ACTIONS } from "./workspace-interaction.js";

export interface PapiControlPlaneOptions {
  /** Engine origin, e.g. https://engine.example.com. No path, query or user info. */
  readonly origin: string;
  /** Operator-configured control site/tenant used in the PAPI path. The SERVICE principal is
   * cross-tenant; Engine switches to each job's tenant itself. */
  readonly site: string;
  readonly tenant: string;
  readonly principalId: string;
  readonly secret: string;
  /** Tests only: allow plain HTTP to a literal loopback origin. */
  readonly allowLoopbackHttp?: boolean;
  readonly send?: typeof fetch;
}

const DOMAIN = "pf.ai.worker.ExecutionDomain";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const REQUEST_LIMIT = 512 * 1024;
/** A generated file of up to 10 MiB travels base64-encoded (about 13.4 MiB) in one request. */
const OUTPUT_REQUEST_LIMIT = 14 * 1024 * 1024;
const OUTPUT_TIMEOUT_MS = 60_000;
/** Bound of one propose call; the caller's retries together stay within the MCP request deadline (45s). */
const PROPOSE_TIMEOUT_MS = 10_000;

/** Platform PAPI client for the SERVICE principal. Endpoints and the service credential are
 * installed by the operator, never selected by a lease or model. No automatic retry here: the
 * lane decides what is safe to resend. Errors never contain bodies, URLs or credentials. */
export class PapiControlPlane implements ControlPlane {
  /** Page actions in the user's browser, relayed by the Engine. */
  readonly clientActions = WORKSPACE_ACTIONS;
  /** In-conversation delegation: propose_task for conversation Runs, report_task for task Runs
   * (see task-delegation.ts). */
  readonly controlTools: readonly ControlTool[] = taskDelegationTools((request, signal) =>
    this.propose(request, signal)
  );
  readonly #base: string;
  readonly #credential: string;
  readonly #send: typeof fetch;

  constructor(options: PapiControlPlaneOptions) {
    let url: URL;
    try {
      url = new URL(options.origin);
    } catch {
      throw new Error("INVALID_CONTROL_PLANE_CONFIGURATION");
    }
    const loopbackHttp =
      url.protocol === "http:" && options.allowLoopbackHttp === true && LOOPBACK.has(url.hostname);
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !SEGMENT.test(options.site) ||
      !SEGMENT.test(options.tenant) ||
      typeof options.principalId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.principalId) ||
      typeof options.secret !== "string" ||
      !/^[\x21-\x7e]{16,512}$/.test(options.secret)
    )
      throw new Error("INVALID_CONTROL_PLANE_CONFIGURATION");
    this.#base = `${url.origin}/papi/${encodeURIComponent(options.site)}/${encodeURIComponent(options.tenant)}/${DOMAIN}::`;
    this.#credential = `${options.principalId}:${options.secret}`;
    this.#send = options.send ?? fetch;
  }

  async claim(request: ClaimRequest, signal: AbortSignal): Promise<readonly unknown[]> {
    return parseClaimResponse(
      await this.call("claim", request, (request.wait_ms ?? 0) + 15_000, signal)
    );
  }

  readLease(raw: unknown, claimToken: string): ClaimedLease | undefined {
    return readLease(raw, claimToken);
  }

  async sync(request: SyncRequest, signal: AbortSignal): Promise<SyncResponse> {
    return parseSyncResponse(
      await this.call("sync", request, (request.wait_ms ?? 0) + 15_000, signal)
    );
  }

  async complete(request: CompleteRequest, signal: AbortSignal): Promise<CompleteResult> {
    return parseCompleteResponse(await this.call("complete", request, 15_000, signal));
  }

  async output(request: OutputRequest, signal: AbortSignal): Promise<OutputResult> {
    return parseOutputResponse(
      await this.call("output", request, OUTPUT_TIMEOUT_MS, signal, OUTPUT_REQUEST_LIMIT)
    );
  }

  /** Hand work to a member mentioned in the message (`ExecutionDomain::propose`). Like the other
   * operations it is not retried here: the caller decides, and a resend must carry the same
   * request_id. */
  async propose(request: ProposeRequest, signal: AbortSignal): Promise<ProposeResult> {
    return parseProposeResponse(await this.call("propose", request, PROPOSE_TIMEOUT_MS, signal));
  }

  /** Returns the envelope's data on success; raises a typed fault on a platform error envelope. */
  private async call(
    operation: "claim" | "sync" | "complete" | "output" | "propose",
    input: unknown,
    timeoutMs: number,
    caller: AbortSignal,
    requestLimit = REQUEST_LIMIT
  ): Promise<unknown> {
    let envelope: unknown;
    try {
      caller.throwIfAborted();
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw Error();
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body) > requestLimit) throw Error();
      const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
      const response = await this.#send(this.#base + operation, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "x-purefect-service-token": this.#credential,
          "content-type": "application/json",
          accept: "application/json"
        },
        body
      });
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!response.body || type !== "application/json") {
        await response.body?.cancel().catch(() => {});
        throw Error();
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > RESPONSE_LIMIT) throw Error();
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
      );
    } catch {
      // Network, timeout, abort, oversize or non-JSON: nothing from the dependency is surfaced.
      throw new ControlPlaneError("CONTROL_PLANE_UNAVAILABLE");
    }
    if (!isObject(envelope) || typeof envelope.success !== "boolean")
      throw new ControlPlaneError("CONTROL_PLANE_PROTOCOL");
    if (envelope.success && envelope.code === 200) return envelope.data;
    if (!envelope.success && isObject(envelope.data)) {
      const fault = envelope.data.fault;
      const vars = envelope.data.error_msg_var;
      const expected =
        isObject(vars) && Number.isSafeInteger(vars.expected) ? Number(vars.expected) : undefined;
      throw faultError(
        typeof fault === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(fault) ? fault : "unknown",
        expected !== undefined && expected >= 0 ? expected : undefined
      );
    }
    throw new ControlPlaneError("CONTROL_PLANE_PROTOCOL");
  }
}
