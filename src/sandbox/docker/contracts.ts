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
import {
  managedTurnInput,
  promptByteLimit,
  parsePromptFormat,
  type PromptFormat
} from "../../common/turn-envelope.js";

/** Broker inputs originate from the authenticated scheduler, never from a model. */
export interface RunSpec {
  schemaVersion: 2;
  allocationId: string;
  /** Harness ID: selects the pinned CLI image and the Driver's launch description. */
  harness: string;
  runId: string;
  tenantId: string;
  userId: string;
  generation: number;
  expiresAt: number;
  /** Short execution lease; the host renews it while the Run is alive. */
  leaseExpiresAt: number;
  prompt: string;
  promptFormat?: PromptFormat;
  /** Engine-authenticated conversation/member coordinates; absent for independent background Runs. */
  session?: Readonly<{ taskId: string; memberId: string }>;
}

export class BrokerError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("INVALID_SPEC", 400, "Expected an object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) {
    throw new BrokerError("INVALID_SPEC", 400, "Unexpected or missing fields");
  }
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new BrokerError("INVALID_SPEC", 400, "Invalid identifier");
  }
  return value;
}

/** Harness IDs are opaque lowercase names (e.g. `codex`, `claude-code`). */
export function harnessId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
    throw new BrokerError("INVALID_SPEC", 400, "Invalid harness");
  }
  return value;
}

export function parseRunSpec(value: unknown, now = Date.now()): RunSpec {
  const v = object(value);
  const fields = [
    "schemaVersion",
    "allocationId",
    "harness",
    "runId",
    "tenantId",
    "userId",
    "generation",
    "expiresAt",
    "leaseExpiresAt",
    "prompt"
  ];
  if (v.session !== undefined) fields.push("session");
  if (v.promptFormat !== undefined) fields.push("promptFormat");
  exactKeys(v, fields);
  if (
    v.schemaVersion !== 2 ||
    !Number.isSafeInteger(v.generation) ||
    Number(v.generation) < 1 ||
    !Number.isSafeInteger(v.expiresAt) ||
    Number(v.expiresAt) <= now ||
    Number(v.expiresAt) > now + 30 * 60_000 ||
    typeof v.prompt !== "string" ||
    !v.prompt.trim() ||
    Buffer.byteLength(v.prompt) > promptByteLimit(v.promptFormat)
  ) {
    throw new BrokerError(
      "INVALID_SPEC",
      400,
      "Invalid version, lease deadline, generation or prompt"
    );
  }
  if (
    !Number.isSafeInteger(v.leaseExpiresAt) ||
    Number(v.leaseExpiresAt) <= now ||
    Number(v.leaseExpiresAt) > now + 60000 ||
    Number(v.leaseExpiresAt) > Number(v.expiresAt)
  ) {
    throw new BrokerError("INVALID_SPEC", 400, "Invalid execution lease");
  }
  let session: RunSpec["session"];
  try {
    managedTurnInput(v.prompt, parsePromptFormat(v.promptFormat));
  } catch {
    throw new BrokerError("INVALID_SPEC", 400, "Invalid turn input");
  }
  if (v.session !== undefined) {
    const s = object(v.session);
    exactKeys(s, ["taskId", "memberId"]);
    session = Object.freeze({ taskId: identifier(s.taskId), memberId: identifier(s.memberId) });
  }
  return Object.freeze({
    schemaVersion: 2,
    allocationId: identifier(v.allocationId),
    harness: harnessId(v.harness),
    runId: identifier(v.runId),
    tenantId: identifier(v.tenantId),
    userId: identifier(v.userId),
    generation: Number(v.generation),
    expiresAt: Number(v.expiresAt),
    leaseExpiresAt: Number(v.leaseExpiresAt),
    prompt: v.prompt,
    ...(v.promptFormat !== undefined ? { promptFormat: parsePromptFormat(v.promptFormat) } : {}),
    ...(session ? { session } : {})
  });
}

export interface RenewalSpec {
  ref: AllocationRef;
  expectedExpiresAt: number;
  requestedExpiresAt: number;
}

export function parseRenewal(value: unknown): RenewalSpec {
  const v = object(value);
  exactKeys(v, ["ref", "expectedExpiresAt", "requestedExpiresAt"]);
  if (
    !Number.isSafeInteger(v.expectedExpiresAt) ||
    Number(v.expectedExpiresAt) < 1 ||
    !Number.isSafeInteger(v.requestedExpiresAt) ||
    Number(v.requestedExpiresAt) <= Number(v.expectedExpiresAt)
  ) {
    throw new BrokerError("INVALID_SPEC", 400, "Invalid renewal deadlines");
  }
  return {
    ref: parseRef(v.ref),
    expectedExpiresAt: Number(v.expectedExpiresAt),
    requestedExpiresAt: Number(v.requestedExpiresAt)
  };
}

export interface AllocationRef {
  allocationId: string;
  tenantId: string;
  runId: string;
  generation: number;
}

export function parseRef(value: unknown): AllocationRef {
  const v = object(value);
  exactKeys(v, ["allocationId", "tenantId", "runId", "generation"]);
  if (!Number.isSafeInteger(v.generation) || Number(v.generation) < 1)
    throw new BrokerError("INVALID_SPEC", 400, "Invalid generation");
  return {
    allocationId: identifier(v.allocationId),
    tenantId: identifier(v.tenantId),
    runId: identifier(v.runId),
    generation: Number(v.generation)
  };
}
