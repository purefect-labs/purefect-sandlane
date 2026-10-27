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
import type {
  HarnessTransport,
  HarnessTransportObserver,
  ProcessStopEvidence
} from "../../spi/harness.js";
import type { BrokerClient } from "./client.js";
import type { AllocationRef } from "./contracts.js";
import type { DockerAttachChannel } from "./docker-attach.js";

export interface BrokerTransportBinding {
  readonly ref: AllocationRef;
  readonly userId: string;
  readonly expiresAt: number;
  readonly nodeId: string;
  /** Runs once when the transport stops, before the CLI's channel closes: the channel's end
   * already makes the Broker terminate the allocation (channel-server), and terminating a session
   * restarts it with an empty workspace. File-mode sessions read their generated files here (the
   * Driver stops its transport as soon as the turn ends). Bounded by the caller; its outcome never
   * changes the stop. */
  readonly beforeTerminate?: () => Promise<void>;
}

/** Ask the Broker to terminate the allocation and verify its receipt: removal, a pre-start
 * tombstone or the session's complete process-namespace stop. Never throws; false means unknown. */
export async function terminateAndVerify(
  broker: Pick<BrokerClient, "status" | "terminate">,
  binding: BrokerTransportBinding
): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(10000);
    const status = await broker.status(signal);
    if (status.nodeId !== binding.nodeId) return false;
    const receipt = await broker.terminate(binding.ref, signal);
    const ref = receipt.ref as Record<string, unknown> | undefined;
    const tombstone =
      receipt.userId === "cancelled-before-start" &&
      receipt.expiresAt === 0 &&
      receipt.digest === "0".repeat(64);
    return !(
      !ref ||
      Object.keys(ref).length !== 4 ||
      Object.entries(binding.ref).some(([key, value]) => ref[key] !== value) ||
      receipt.state !== "terminated" ||
      (receipt.sessionKey !== undefined && receipt.stopEvidence !== "process-namespace-stopped") ||
      (!tombstone && (receipt.userId !== binding.userId || receipt.expiresAt !== binding.expiresAt))
    );
  } catch {
    return false;
  }
}

/** Driver-facing bytes and observed cleanup only. Docker access remains exclusively inside Broker. */
export class BrokerHarnessTransport implements HarnessTransport {
  private readonly binding: BrokerTransportBinding;
  private readonly abort = new AbortController();
  private channel?: DockerAttachChannel;
  private pump?: Promise<void>;
  private started = false;
  private stopping = false;
  private stopped?: Promise<ProcessStopEvidence>;

  constructor(
    private readonly broker: Pick<BrokerClient, "status" | "openChannel" | "terminate">,
    binding: BrokerTransportBinding
  ) {
    this.binding = Object.freeze({ ...binding, ref: Object.freeze({ ...binding.ref }) });
  }

  async start(observer: HarnessTransportObserver): Promise<void> {
    if (this.started || this.stopping) throw new Error("BROKER_TRANSPORT_ALREADY_USED");
    this.started = true;
    try {
      const status = await this.broker.status(this.abort.signal);
      if (status.nodeId !== this.binding.nodeId || status.ready !== true) throw Error();
      this.abort.signal.throwIfAborted();
      this.channel = await this.broker.openChannel(
        this.binding.ref,
        this.binding.expiresAt,
        this.abort.signal
      );
      this.abort.signal.throwIfAborted();
      const channel = this.channel;
      this.pump = (async () => {
        try {
          for await (const bytes of channel.output) observer.stdout(bytes);
        } catch {
          /* Only a sanitized fault crosses the Driver port. */
        }
        if (!this.stopping) observer.fault();
      })();
    } catch {
      throw new Error("BROKER_TRANSPORT_UNAVAILABLE");
    }
  }

  async write(frame: Buffer): Promise<void> {
    if (!this.channel || this.stopping) throw new Error("BROKER_TRANSPORT_CLOSED");
    await this.channel.write(frame);
  }

  stop(): Promise<ProcessStopEvidence> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.stopped = (async () => {
      await this.binding.beforeTerminate?.().catch(() => {});
      this.abort.abort();
      this.channel?.close();
      try {
        if (!(await terminateAndVerify(this.broker, this.binding))) throw Error();
        await this.pump;
        // Broker verified removal or the session's complete process-namespace stop.
        // A credential-free idle restart is not a continuation of the terminated Run.
        return { state: "exited", code: null, signal: null } as const;
      } catch {
        return { state: "unknown" } as const;
      }
    })();
    return this.stopped;
  }
}
