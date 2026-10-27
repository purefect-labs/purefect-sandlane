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
/** ContextProvider SPI: turns the control plane's frozen Run input (prompt, history, page
 * context) plus optional system instructions and memory into one turn's input. Decorators (e.g.
 * memory) wrap another provider. */
import type { PromptFormat } from "../common/turn-envelope.js";
import type { FrozenRunInput } from "./control-plane.js";
import type { WebAccessPolicy } from "./web-access.js";

export interface TurnRequest {
  readonly runId: string;
  readonly conversationId: string;
  /** Owner scope from the lease, never from the prompt. */
  readonly tenantId: string;
  readonly userId: string;
  readonly input: FrozenRunInput;
  /** Web access of the Run, so instructions can describe what is available. */
  readonly webAccess: WebAccessPolicy;
  /** Operations the user must approve before they run (lease policy; empty = none). */
  readonly confirmOperations: readonly string[];
  /** Tools the control plane allows this Run (lease `tools`); absent = every enabled tool. The
   * Worker offers only these, so instructions should describe only these. */
  readonly tools?: readonly string[];
  /** The Run has conversation files: they are staged in the workspace's inputs directory with a
   * manifest (some may be listed as not loaded), so instructions can point the model there. */
  readonly inputFiles?: boolean;
  /** Short notes for the model from the control plane tools offered to this Run (e.g. a task Run
   * must report before it ends), written by the control plane; absent when there are none. */
  readonly toolNotes?: readonly string[];
  /** Nobody can answer the Run's client actions (see ClientActionTool.attended): no page tool and
   * no approvals, so instructions must not offer page actions and should say that calls needing
   * approval cannot run. */
  readonly unattended?: boolean;
}

export interface TurnContext {
  /** Versioned envelope; the sandbox and Driver validate it again. */
  readonly prompt: string;
  readonly promptFormat: PromptFormat;
  /** Extra data items placed before the prompt (e.g. saved memory); never instructions. */
  readonly contextData?: readonly string[];
  /** Host-selected system instructions; absent = the CLI's default. */
  readonly instructions?: string;
}

export interface ContextProvider {
  /** Throws when the input cannot be turned into a bounded turn (the Run fails as invalid input). */
  turn(request: TurnRequest, signal: AbortSignal): Promise<TurnContext>;
}
