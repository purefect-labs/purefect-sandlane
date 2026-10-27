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
/** HarnessDriver SPI: drives one agent CLI turn inside a sandbox session and reports standard
 * events. Independent of a vendor SDK or sandbox provider. */
import type { PromptFormat } from "../common/turn-envelope.js";
import type { ReasoningEffort } from "./control-plane.js";
import type { ModelWire } from "./model-upstream.js";

/** One turn's input. Every tool, including the control plane's client action, reaches the CLI
 * through the tool gateway (MCP), so the Driver needs no tool bridge. */
export interface RunInput {
  runId: string;
  prompt: string;
  promptFormat?: PromptFormat;
  /** Optional application conversation identity and Host-provided memory data, never model-selected. */
  conversationId?: string;
  contextData?: readonly string[];
  /** Host-selected system instructions for the session (ContextProvider); absent = CLI default. */
  instructions?: string;
  /** Optional admission gate awaited right before the model turn starts. The Driver may prepare
   * the CLI and thread meanwhile; a rejection fails the Run without sending any model request. */
  beforeTurn?: () => Promise<void>;
  expiresAt: number;
  /** Per-Run reasoning effort from the control plane; overrides the Driver's default. */
  reasoningEffort?: ReasoningEffort;
  /** performance.now() origin for timing phases (e.g. the Run's claim); default: execute(). */
  timingOrigin?: number;
  /** File mode: the sandbox workspace holds the Run's conversation files and the CLI was
   * launched with its file and command tools (HarnessLaunchConfig.fileTools). The container is
   * the sandbox, so the Driver must not ask for approvals or apply a CLI sandbox of its own. */
  fileTools?: boolean;
}

/** Driver observations. The control plane remains authoritative for Run state and business
 * effects. */
export interface RuntimeEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  /** item.* carry a sanitized tool-call summary only (never arguments or results). */
  type:
    | "message.delta"
    | "item.started"
    | "item.completed"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  data: Record<string, unknown>;
}

export interface HarnessCapabilities {
  readonly schemaVersion: 1;
  readonly streamingText: boolean;
  readonly interactiveInput: boolean;
  readonly approvalBridge: boolean;
  readonly nativeResume: boolean;
  /** Model API the CLI speaks; the model gateway serves the matching entry codec. */
  readonly modelWire: ModelWire;
  /** `ephemeral`: one CLI thread per Run (implemented). `sticky`: reserved for session-resident
   * CLIs. */
  readonly sessionPolicy: "ephemeral" | "sticky";
}

/** Single-use execution contract: one instance, one Run. */
export interface HarnessDriver {
  readonly capabilities: HarnessCapabilities;
  readonly stopEvidence: ProcessStopEvidence | undefined;
  on(event: "event", listener: (event: RuntimeEvent) => void): this;
  execute(input: RunInput): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export type ProcessStopEvidence =
  | { readonly state: "not-started" }
  | {
      readonly state: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly state: "spawn-failed" }
  | { readonly state: "unknown" };

export interface HarnessTransportObserver {
  stdout(chunk: Buffer): void;
  fault(): void;
  exited(evidence: ProcessStopEvidence): void;
}

/** The sandbox `stdio` channel the Driver speaks over: bytes only, no Harness protocol, tenant
 * authorization or Run state. Implementations are operator-selected, never supplied by a Run or
 * model. Process exit is NOT proof that a sandbox stopped or a business action rolled back. */
export interface HarnessTransport {
  start(observer: HarnessTransportObserver): Promise<void>;
  write(frame: Buffer): Promise<void>;
  stop(): Promise<ProcessStopEvidence>;
}

/** Per-Run CLI configuration inputs: operator-pinned gateway endpoints plus the Run's scoped
 * capabilities. NEVER provider keys, user tokens or node service credentials. */
export interface HarnessLaunchConfig {
  modelAlias: string;
  /** Model gateway base URL (`https://host[:port]/v1`); each Driver derives the form its CLI
   * expects (e.g. the origin only). */
  modelBaseUrl: string;
  modelCapability: string;
  mcpUrl: string;
  /** Name the CLI registers the tool gateway under; the model sees tools in this namespace. */
  toolServer: string;
  toolCapability: string;
  enabledTools: readonly string[];
  /** File mode: the Run has conversation files in the workspace. The CLI additionally gets its
   * built-in file reading and command tools (inside the sandbox only); Runs without files keep
   * the MCP-only tool set. The model gateway admits the matching functions for such Runs only. */
  fileTools?: boolean;
}

/** CLI arguments and environment generated by the Driver; the sandbox applies them without
 * knowing the CLI's configuration format. */
export interface HarnessLaunch {
  args: string[];
  env: Record<string, string>;
}

/** The Driver's launch description. The sandbox starts `command` from its pinned CLI image and
 * knows nothing else about the CLI. */
export interface HarnessLauncher {
  /** Absolute path of the CLI executable inside the image. */
  readonly command: string;
  /** Arguments without per-Run configuration (e.g. the CLI's server subcommand). */
  readonly args: readonly string[];
  /** Fixed environment, e.g. the CLI's state directory. */
  readonly env: Readonly<Record<string, string>>;
  /** Writable directories the CLI needs on a read-only root filesystem. */
  readonly stateDirs: readonly string[];
  /** Per-Run arguments (including `args`) and capability environment. */
  configure(config: HarnessLaunchConfig): HarnessLaunch;
}
