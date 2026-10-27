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
import type { HarnessDriver } from "../../spi/harness.js";
import {
  HARNESS_UNAVAILABLE,
  INPUTS_UNAVAILABLE,
  type SandboxOutputs,
  type SandboxProvider,
  type SandboxRequest,
  type SandboxSession
} from "../../spi/sandbox.js";
import { terminateAndVerify, type BrokerTransportBinding } from "./broker-transport.js";
import type { BrokerClient } from "./client.js";
import { BrokerError, parseRunSpec, type AllocationRef } from "./contracts.js";
import { parseRunAuthorization } from "./managed-launch.js";

type Broker = Pick<
  BrokerClient,
  "status" | "allocateManaged" | "renew" | "terminate" | "putInputs" | "getOutputs"
>;

const RENEW_STEP_MS = 5_000;
const BROKER_LEASE_MAX_MS = 55_000;
/** Reading generated files while the transport stops after the CLI's turn: a little above the
 * Broker's own 30 s read limit, so such a stop is never held up longer than that. A stop the
 * caller forced (cancellation, shutdown) does not read at all (SandboxRequest.outputsAbandoned). */
const OUTPUTS_READ_TIMEOUT_MS = 35_000;

/** Creates the Driver of one Harness, bound to an allocation's channel. */
export type BrokerDriverFactory = (binding: BrokerTransportBinding) => HarnessDriver;

/** Docker execution profile through the node-local Broker. Only the Run's scoped model/tool
 * capabilities enter the container (managed launch); the agent token and model key stay in the
 * runtime process. The Driver of the Run's Harness (over BrokerHarnessTransport) is created per
 * allocation; a Harness needs both a Driver here and a CLI image on the Broker. */
export class BrokerSandboxLauncher implements SandboxProvider {
  readonly capabilities = Object.freeze({
    isolation: "container" as const,
    sessionReuse: true,
    channels: Object.freeze(["stdio" as const])
  });

  constructor(
    private readonly broker: Broker,
    private readonly nodeId: string,
    private readonly drivers: Readonly<Record<string, BrokerDriverFactory>>
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(nodeId)) throw new Error("INVALID_BROKER_NODE");
    this.drivers = Object.freeze({ ...drivers });
  }

  async open(request: SandboxRequest, signal: AbortSignal): Promise<SandboxSession> {
    const createDriver = Object.hasOwn(this.drivers, request.harness)
      ? this.drivers[request.harness]
      : undefined;
    if (!createDriver) throw new Error(HARNESS_UNAVAILABLE);
    const status = await this.broker.status(signal);
    if (status.nodeId !== this.nodeId || status.ready !== true || status.managedLaunch !== true)
      throw new Error("BROKER_UNAVAILABLE");
    // The Broker lists the Harnesses it has CLI images for; refuse before allocating.
    if (!Array.isArray(status.harnesses) || !status.harnesses.includes(request.harness))
      throw new Error(HARNESS_UNAVAILABLE);
    const spec = parseRunSpec({
      schemaVersion: 2,
      allocationId: request.allocationId,
      harness: request.harness,
      tenantId: request.tenantId,
      userId: request.userId,
      runId: request.runId,
      generation: request.generation,
      expiresAt: request.expiresAt,
      leaseExpiresAt: request.leaseExpiresAt,
      prompt: request.prompt,
      ...(request.promptFormat !== "text" ? { promptFormat: request.promptFormat } : {}),
      // Broker session reuse is keyed by conversation and member.
      session: { taskId: request.conversationId, memberId: request.userId }
    });
    const authorization = parseRunAuthorization(
      {
        modelAlias: request.modelAlias,
        toolServer: request.toolServer,
        enabledTools: [...request.enabledTools],
        model: { value: request.modelCapability, expiresAt: request.expiresAt },
        tool: { value: request.toolCapability, expiresAt: request.expiresAt },
        // File mode follows the inputs: the CLI gets its file tools only over written files.
        ...(request.inputs?.length ? { fileTools: true } : {})
      },
      request.expiresAt,
      Date.now()
    );
    const ref: AllocationRef = Object.freeze({
      allocationId: spec.allocationId,
      tenantId: spec.tenantId,
      runId: spec.runId,
      generation: spec.generation
    });
    try {
      const reply = await this.broker.allocateManaged(spec, authorization, signal);
      const returned = reply.ref as Record<string, unknown> | undefined;
      if (
        !returned ||
        Object.keys(returned).length !== 4 ||
        Object.entries(ref).some(([key, value]) => returned[key] !== value) ||
        reply.userId !== spec.userId ||
        reply.expiresAt !== spec.expiresAt ||
        reply.leaseExpiresAt !== spec.leaseExpiresAt ||
        reply.state !== "allocating"
      )
        throw new Error("BROKER_PROTOCOL");
    } catch {
      // A lost reply may still have created the allocation: terminate before reporting failure.
      await this.broker.terminate(ref, AbortSignal.timeout(10_000)).catch(() => {});
      throw new Error("SANDBOX_UNAVAILABLE");
    }
    // Input files go in before the channel (and so the CLI) starts; without them the Run's
    // instructions would point at files that are not there.
    if (request.inputs?.length) {
      try {
        const reply = await this.broker.putInputs(ref, request.inputs, signal);
        const returned = reply.ref as Record<string, unknown> | undefined;
        if (
          !returned ||
          Object.entries(ref).some(([key, value]) => returned[key] !== value) ||
          reply.files !== request.inputs.length
        )
          throw new Error("BROKER_PROTOCOL");
      } catch {
        await this.broker.terminate(ref, AbortSignal.timeout(10_000)).catch(() => {});
        throw new Error(INPUTS_UNAVAILABLE);
      }
    }
    // Generated files are read once, when the transport stops (the Driver stops it as soon as the
    // turn ends; termination empties the workspace), and handed to outputs() from memory. Not
    // once the caller abandoned them (it ended the CLI itself): a cancellation or shutdown must
    // not keep the CLI and its capabilities alive for the read, and a read in progress ends then.
    const abandoned = request.outputsAbandoned;
    let outputsRead: Promise<SandboxOutputs> | undefined;
    const readOutputs = (): Promise<SandboxOutputs> =>
      (outputsRead ??= this.broker
        .getOutputs(
          ref,
          abandoned
            ? AbortSignal.any([AbortSignal.timeout(OUTPUTS_READ_TIMEOUT_MS), abandoned])
            : AbortSignal.timeout(OUTPUTS_READ_TIMEOUT_MS)
        )
        .catch(error => {
          if (abandoned?.aborted) throw new Error("OUTPUTS_ABANDONED");
          // The Broker's code only (e.g. OUTPUTS_DENIED); never a transport message.
          throw new Error(
            error instanceof BrokerError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
              ? error.code
              : "OUTPUTS_UNAVAILABLE"
          );
        }));
    const binding: BrokerTransportBinding = Object.freeze({
      ref,
      userId: spec.userId,
      expiresAt: spec.expiresAt,
      nodeId: this.nodeId,
      ...(request.inputs?.length
        ? {
            beforeTerminate: async () => {
              if (abandoned?.aborted) return;
              await readOutputs().catch(() => {});
            }
          }
        : {})
    });
    const driver = createDriver(binding);
    let disposed = false;
    let confirmed = false;
    let brokerLease = spec.leaseExpiresAt;
    // A renewal whose reply was lost may already be recorded by the Broker. Retry exactly the
    // same request until it is confirmed: the Broker accepts a replay (current == requested),
    // whereas a new target with the old expected value would be rejected as a conflict.
    let pending: { expected: number; target: number } | undefined;
    let renewing: Promise<void> | undefined;
    return {
      driver,
      // Only a file-mode session (inputs written) has an outputs directory worth reading.
      ...(request.inputs?.length
        ? {
            // Usually already read when the Driver stopped its transport; otherwise read now
            // (the session is still running), unless abandoned meanwhile.
            outputs: async (outputSignal: AbortSignal) => {
              outputSignal.throwIfAborted();
              if (!outputsRead && abandoned?.aborted) throw new Error("OUTPUTS_ABANDONED");
              const aborted = new Promise<never>((_, reject) =>
                outputSignal.addEventListener("abort", () => reject(new Error("OUTPUTS_TIMEOUT")), {
                  once: true
                })
              );
              return Promise.race([readOutputs(), aborted]);
            }
          }
        : {}),
      renew: (leaseUntil, renewSignal) => {
        if (renewing) return Promise.resolve();
        if (!pending) {
          const target = Math.min(leaseUntil, Date.now() + BROKER_LEASE_MAX_MS, spec.expiresAt);
          if (target - brokerLease < RENEW_STEP_MS) return Promise.resolve();
          pending = { expected: brokerLease, target };
        }
        const attempt = pending;
        renewing = (async () => {
          const reply = await this.broker.renew(
            { ref, expectedExpiresAt: attempt.expected, requestedExpiresAt: attempt.target },
            renewSignal
          );
          if (reply.leaseExpiresAt !== attempt.target) throw new Error("BROKER_PROTOCOL");
          brokerLease = attempt.target;
          pending = undefined;
        })().finally(() => {
          renewing = undefined;
        });
        return renewing;
      },
      close: async () => {
        if (confirmed) return "stopped";
        if (!disposed) {
          // The Driver's dispose stops its transport, which terminates and verifies the allocation.
          disposed = true;
          await driver.dispose().catch(() => {});
          confirmed = driver.stopEvidence?.state === "exited";
        } else {
          // The Driver caches its first stop result: a retry must ask the Broker again.
          confirmed = await terminateAndVerify(this.broker, binding);
        }
        return confirmed ? "stopped" : "unknown";
      }
    };
  }
}
