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
/** SandboxProvider SPI: isolated execution sessions for one Run each. */
import type { OutputRejection } from "../common/output-files.js";
import type { PromptFormat } from "../common/turn-envelope.js";
import type { HarnessDriver } from "./harness.js";

/** What the sandbox receives: Run coordinates, the frozen prompt and scoped capabilities.
 * Raw credentials (agent token, model key) never appear here. */
export interface SandboxRequest {
  readonly allocationId: string;
  /** Harness ID from the lease: selects the Driver and the CLI image. */
  readonly harness: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly userId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly expiresAt: number;
  readonly leaseExpiresAt: number;
  readonly prompt: string;
  readonly promptFormat: PromptFormat;
  readonly modelAlias: string;
  /** Name under which the CLI registers the tool gateway (see HarnessLaunchConfig). */
  readonly toolServer: string;
  readonly enabledTools: readonly string[];
  readonly modelCapability: string;
  readonly toolCapability: string;
  /** Files written to the workspace's inputs directory before the CLI starts (see
   * common/input-files: safe single-component names and limits, which the provider enforces
   * again). Content only: never URLs or credentials. Absent = nothing is written. */
  readonly inputs?: readonly SandboxInputFile[];
  /** Aborted once the Run's generated files are no longer wanted: the caller ended the CLI itself
   * (cancellation, shutdown, deadline, lost lease) instead of the CLI finishing its turn, or is
   * already stopping the sandbox. A provider that reads the files while the CLI stops must then
   * skip the read, or abandon one in progress, so the stop is never held up by it. Absent: the
   * files are always wanted. */
  readonly outputsAbandoned?: AbortSignal;
}

export interface SandboxInputFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Files the CLI left in the workspace's outputs directory (see common/output-files): regular
 * files with safe names within the sandbox's limits, and the entries refused with a reason.
 * Content only, unchecked beyond that: the caller validates types before passing them on. */
export interface SandboxOutputs {
  readonly files: readonly SandboxOutputFile[];
  readonly rejected: readonly { readonly name: string; readonly reason: OutputRejection }[];
}

export interface SandboxOutputFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface SandboxSession {
  /** Driver bound to the session's channel; disposing it stops the CLI. */
  readonly driver: HarnessDriver;
  /** Read the generated files after the CLI's turn and before close(); absent when the provider
   * (or this session, e.g. without input files) offers none. Reading changes nothing. Fails
   * once the files were abandoned (SandboxRequest.outputsAbandoned) before they were read. */
  outputs?(signal: AbortSignal): Promise<SandboxOutputs>;
  /** Extend the sandbox watchdog to follow the renewed control plane lease. */
  renew(leaseUntil: number, signal: AbortSignal): Promise<void>;
  /** Stop and confirm. Never infer stop from a sent signal. */
  close(): Promise<"stopped" | "unknown">;
}

export interface SandboxCapabilities {
  /** `container`: kernel-enforced isolation. `local`: host process, development only. */
  readonly isolation: "container" | "local";
  /** Whether an idle session (same conversation and member) is reused by the next Run. */
  readonly sessionReuse: boolean;
  /** `stdio`: the CLI's standard streams (implemented). `http-port`: reserved for an in-sandbox
   * service reached through the provider, never through a network listener. */
  readonly channels: readonly ("stdio" | "http-port")[];
}

/** Error message of open() when the requested Harness has no Driver or CLI image here. The lane
 * settles such a Run as a definite failure instead of a transient sandbox fault. */
export const HARNESS_UNAVAILABLE = "HARNESS_UNAVAILABLE";

/** Error message of open() when the sandbox started but the request's input files could not be
 * written; the provider has already released the sandbox. */
export const INPUTS_UNAVAILABLE = "INPUTS_UNAVAILABLE";

/** Operator-installed sandbox port. Must clean up a partially created sandbox itself when
 * open() fails. */
export interface SandboxProvider {
  readonly capabilities: SandboxCapabilities;
  open(request: SandboxRequest, signal: AbortSignal): Promise<SandboxSession>;
}
