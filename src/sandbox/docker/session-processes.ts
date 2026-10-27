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
import { setTimeout as delay } from "node:timers/promises";
import { BrokerError, object } from "./contracts.js";
import type { Engine } from "./docker-engine.js";

/** Stdin frame size for an extraction (the attach channel accepts up to 128 KiB per write). */
const EXTRACT_FRAME = 64 * 1024;
/** `tar` from the CLI image, reading the Broker-built archive from stdin. */
const EXTRACT_COMMAND = Object.freeze(["tar", "-x", "-f", "-", "-C", "/workspace"]);
/** Largest Docker output frame (see DockerOutputDecoder). */
const READ_FRAME_ALLOWANCE = 128 * 1024;

/** The idle PID 1 has no credentials and cannot start work. Each CLI runs via Docker exec. */
export class SessionProcesses {
  constructor(private readonly engine: Engine) {}

  /** Extract `archive` (built by session-inputs) under /workspace as the runner user. The
   * workspace is a tmpfs, which the Docker archive API cannot write into, so `tar` runs in a
   * credential-free exec and reads the archive from stdin. Resolves only after the exec exited
   * with status 0; anything else (no `tar`, a full workspace, a broken stream) rejects. */
  async extract(
    containerId: string,
    archive: readonly Buffer[],
    expiresAt: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.engine.startExec)
      throw new BrokerError("INPUTS_UNSUPPORTED", 409, "Engine cannot run session processes");
    const created = object(
      await this.engine.request("POST", `/containers/${containerId}/exec`, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Cmd: [...EXTRACT_COMMAND],
        Env: []
      })
    );
    const execId = this.execId(created.Id);
    const channel = await this.engine.startExec(execId, expiresAt, signal);
    try {
      if (!channel.end) throw new Error("Channel cannot end its input");
      // Output is discarded but always drained, so tar never blocks on a full pipe.
      const drained = (async () => {
        for await (const chunk of channel.output) void chunk;
      })();
      drained.catch(() => {});
      for (const part of archive)
        for (let offset = 0; offset < part.length; offset += EXTRACT_FRAME)
          await channel.write(part.subarray(offset, offset + EXTRACT_FRAME));
      await channel.end();
      await drained;
    } catch {
      throw new BrokerError("INPUTS_FAILED", 503, "Input stream to the session failed");
    } finally {
      channel.close();
    }
    if ((await this.exitCode(execId)) !== 0)
      throw new BrokerError("INPUTS_FAILED", 503, "Input extraction failed");
  }

  /** Run `command` (no shell, no stdin, no environment) as the runner user and collect its
   * stdout up to `maxBytes`. Past the cap the channel is closed and `complete` is false (the exit
   * status is then not awaited); otherwise `exitCode` is the process's status. Stderr is drained
   * and discarded. */
  async read(
    containerId: string,
    command: readonly string[],
    maxBytes: number,
    expiresAt: number,
    signal: AbortSignal
  ): Promise<{ stdout: Buffer; complete: boolean; exitCode?: number | undefined }> {
    if (!this.engine.startExec)
      throw new BrokerError("OUTPUTS_UNSUPPORTED", 409, "Engine cannot run session processes");
    const created = object(
      await this.engine.request("POST", `/containers/${containerId}/exec`, {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Cmd: [...command],
        Env: []
      })
    );
    const execId = this.execId(created.Id);
    // The decoder's own limit sits one frame above the cap, so the cap below is always reached
    // first and an oversized output ends as "incomplete" rather than as a stream error.
    const channel = await this.engine.startExec(execId, expiresAt, signal, {
      maxOutputBytes: maxBytes + READ_FRAME_ALLOWANCE
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let complete = true;
    try {
      for await (const chunk of channel.output) {
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          complete = false;
          break;
        }
        chunks.push(chunk);
        size += chunk.length;
      }
    } catch {
      throw new BrokerError("OUTPUTS_FAILED", 503, "Output stream from the session failed");
    } finally {
      channel.close();
    }
    const stdout = Buffer.concat(chunks, size);
    if (!complete) return { stdout, complete };
    return { stdout, complete, exitCode: await this.exitCode(execId) };
  }

  /** The exit status once the exec has stopped; undefined when that cannot be confirmed. The
   * stream ends when the process exits; its exit state may follow a moment later. */
  private async exitCode(execId: string): Promise<number | undefined> {
    for (let attempt = 0; ; attempt++) {
      const info = object(await this.engine.request("GET", `/exec/${execId}/json`));
      if (info.Running === false && Number.isSafeInteger(info.ExitCode))
        return Number(info.ExitCode);
      if (info.Running === false || attempt >= 20) return undefined;
      await delay(50);
    }
  }

  /** `command` is the CLI executable followed by its arguments. */
  async create(
    containerId: string,
    command: readonly string[],
    env: readonly string[]
  ): Promise<string> {
    const created = object(
      await this.engine.request("POST", `/containers/${containerId}/exec`, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Cmd: [...command],
        Env: [...env]
      })
    );
    return this.execId(created.Id);
  }

  /** A Docker stop kills the entire process namespace, including detached CLI descendants.
   * The same container can then restart its credential-free idle command. Tmpfs is reset;
   * conversation memory belongs to Engine, not to leftover CLI files or processes.
   */
  async stop(containerId: string): Promise<void> {
    await this.engine.request("POST", `/containers/${containerId}/stop?t=0`);
    const info = object(await this.engine.request("GET", `/containers/${containerId}/json`));
    if (object(info.State).Running !== false) {
      throw new BrokerError("SESSION_STOP_UNCONFIRMED", 503, "Session process cleanup unconfirmed");
    }
  }

  private execId(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid exec ID");
    }
    return value;
  }
}
