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

/** What a lane is doing: waiting between claims, long-polling a claim, executing a Run, or
 * stopped (drained or shut down). */
export type LaneState = "idle" | "claiming" | "running" | "stopped";

/** How a finished Run left the Worker: outcome delivered, delivery refused or abandoned, lease
 * lost (never completed), or settlement withheld because the sandbox stop was unconfirmed. */
export type RunSettlement = "settled" | "rejected" | "lost" | "withheld";

/** Status observations: states, identifiers, counts, timings and fixed error codes only. Never
 * credentials, prompts, answers, tool arguments or results, or user and tenant identifiers. */
export type StatusEvent =
  | { readonly type: "lane"; readonly state: LaneState; readonly error?: string }
  | { readonly type: "run.started"; readonly run: string; readonly harness: string }
  /** `elapsedMs` since the Run's claim returned (the TIMING clock). */
  | {
      readonly type: "run.phase";
      readonly run: string;
      readonly phase: string;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "run.ended";
      readonly run: string;
      readonly status: "SUCCEEDED" | "FAILED" | "CANCELLED";
      readonly settlement: RunSettlement;
      readonly error?: string;
    }
  /** One tool call of a Run that reached the tool authority (audit outcome). */
  | { readonly type: "run.tool"; readonly run: string; readonly ok: boolean }
  | { readonly type: "gateway.start"; readonly gateway: "model" | "tool" }
  | {
      readonly type: "gateway.end";
      readonly gateway: "model" | "tool";
      readonly ok: boolean;
      readonly error?: string;
    }
  /** A background connection to a model upstream opened ahead of a request. */
  | {
      readonly type: "upstream.preconnect";
      readonly ok: boolean;
      readonly elapsedMs?: number;
      readonly error?: string;
    };

/** Injected recorder. Must be O(1), never throw and never block the caller. */
export type StatusObserver = (event: StatusEvent) => void;
