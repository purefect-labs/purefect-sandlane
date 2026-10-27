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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type {
  HarnessTransport,
  HarnessTransportObserver,
  ProcessStopEvidence
} from "../../spi/harness.js";

export interface LocalProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly workspace: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Existing local/container-local execution. This implementation is NOT a Docker remote transport. */
export class LocalProcessTransport implements HarnessTransport {
  private readonly launch: LocalProcessLaunch;
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<ProcessStopEvidence> | undefined;
  private closing = false;
  private writing = false;
  private evidence: ProcessStopEvidence | undefined;
  private observedExit: Promise<ProcessStopEvidence> | undefined;

  constructor(launch: LocalProcessLaunch) {
    this.launch = Object.freeze({
      ...launch,
      args: Object.freeze([...launch.args]),
      env: Object.freeze({ ...launch.env })
    });
  }

  start(observer: HarnessTransportObserver): Promise<void> {
    if (this.starting || this.closing)
      return Promise.reject(new Error("Transport cannot be reused"));
    this.starting = this.launchProcess(observer);
    return this.starting;
  }

  private async launchProcess(observer: HarnessTransportObserver): Promise<void> {
    try {
      await mkdir(this.launch.home, { recursive: true, mode: 0o700 });
      await mkdir(this.launch.workspace, { recursive: true, mode: 0o700 });
      if (this.closing) throw new Error("Transport closed");
      const child = spawn(this.launch.command, [...this.launch.args], {
        cwd: this.launch.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...this.launch.env }
      });
      this.child = child;
      this.observedExit = new Promise(resolve => {
        const settle = (evidence: ProcessStopEvidence) => {
          if (this.evidence) return;
          this.evidence = Object.freeze(evidence);
          resolve(this.evidence);
        };
        child.once("error", () => settle({ state: "spawn-failed" }));
        child.once("exit", (code, signal) => settle({ state: "exited", code, signal }));
      });
      // `exit` can precede the final stdout frames; notify the protocol only after pipes close.
      child.once("close", () => {
        if (this.evidence) observer.exited(this.evidence);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (!this.closing) observer.stdout(chunk);
      });
      const onPipeError = () => {
        if (!this.closing) observer.fault();
      };
      child.stdout.on("error", onPipeError);
      child.stdin.on("error", onPipeError);
      // No diagnostic content crosses the boundary; also bound a noisy stderr producer.
      let diagnosticBytes = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (!this.closing && diagnosticBytes > 4 * 1024 * 1024) observer.fault();
      });
      child.stderr.on("error", onPipeError);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(new Error("Harness process failed")));
      });
    } catch {
      throw new Error("Harness transport start failed");
    }
  }

  async write(frame: Buffer): Promise<void> {
    const child = this.child;
    if (this.closing || this.evidence || !child?.stdin.writable)
      throw new Error("Harness not writable");
    if (this.writing || frame.length > 128 * 1024) throw new Error("Harness input limit");
    this.writing = true;
    try {
      const copy = Buffer.from(frame);
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(copy, error =>
          error ? reject(new Error("Harness input closed")) : resolve()
        );
      });
    } finally {
      this.writing = false;
    }
  }

  stop(): Promise<ProcessStopEvidence> {
    // Mark closing before awaiting start: cancellation during mkdir must prevent a late spawn.
    this.closing = true;
    this.stopping ??= this.stopProcess();
    return this.stopping;
  }

  private async stopProcess(): Promise<ProcessStopEvidence> {
    // A sent signal is not stop evidence. Wait for exit, escalate once, then report unknown.
    await this.starting?.catch(() => {});
    const child = this.child;
    if (!child) return { state: "not-started" };
    let kill: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (this.evidence) return this.evidence;
      this.signal("SIGTERM");
      kill = setTimeout(() => this.signal("SIGKILL"), 1_000);
      return await Promise.race([
        this.observedExit!,
        new Promise<ProcessStopEvidence>(resolve => {
          timeout = setTimeout(() => resolve({ state: "unknown" }), 3_000);
        })
      ]);
    } finally {
      if (kill) clearTimeout(kill);
      if (timeout) clearTimeout(timeout);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid || this.evidence) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* Only observed exit proves a stop. Permission/OS failures become UNKNOWN. */
    }
  }
}
