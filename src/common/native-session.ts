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

/** Bounded opaque native conversation state, never a credential/configuration directory or archive. */
export const NATIVE_STATE_BYTES = 1024 * 1024;
export const NATIVE_BODY_BYTES = NATIVE_STATE_BYTES + 8192;
export const NATIVE_STATE_KINDS = Object.freeze([
  "codex-rollout-v1",
  "claude-session-v1",
  "qwen-session-v1",
  "opencode-export-v1"
] as const);
export type NativeStateKind = (typeof NATIVE_STATE_KINDS)[number];
export interface NativeThread {
  readonly kind: NativeStateKind;
  readonly threadId: string;
  readonly path: string;
}
export interface NativeSnapshot extends NativeThread {
  readonly containerId: string;
  readonly brokerEpoch: string;
  readonly data: Uint8Array;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPENCODE_ID = /^ses_[A-Za-z0-9]{12,64}$/;

export function nativeThread(value: unknown, expectedKind?: NativeStateKind): NativeThread {
  const v = value as NativeThread;
  const kind = v?.kind;
  const id = v?.threadId;
  const supported =
    typeof kind === "string" && NATIVE_STATE_KINDS.some(candidate => candidate === kind);
  const validPath =
    kind === "codex-rollout-v1"
      ? UUID.test(id) &&
        new RegExp(
          "^/home/runner/\\.codex/sessions/[0-9]{4}/[0-9]{2}/[0-9]{2}/rollout-[0-9T:-]{19}-" +
            id +
            "\\.jsonl$"
        ).test(v.path)
      : kind === "claude-session-v1"
        ? UUID.test(id) && v.path === `/home/runner/.claude/projects/-workspace/${id}.jsonl`
        : kind === "qwen-session-v1"
          ? UUID.test(id) &&
            v.path === `/home/runner/.qwen/sandlane/projects/-workspace/chats/${id}.jsonl`
          : kind === "opencode-export-v1"
            ? OPENCODE_ID.test(id) &&
              v.path === `/home/runner/.local/state/opencode/sandlane/native/${id}.json`
            : false;
  if (
    !v ||
    !supported ||
    (expectedKind !== undefined && kind !== expectedKind) ||
    typeof id !== "string" ||
    typeof v.path !== "string" ||
    !validPath
  )
    throw Error("NATIVE_STATE_INVALID");
  return { kind: kind as NativeStateKind, threadId: id, path: v.path };
}

export function nativeKindForHarness(harness: unknown): NativeStateKind | undefined {
  return harness === "codex"
    ? "codex-rollout-v1"
    : harness === "claude-code"
      ? "claude-session-v1"
      : harness === "qwen-code"
        ? "qwen-session-v1"
        : harness === "opencode"
          ? "opencode-export-v1"
          : undefined;
}

export function nativeThreadPath(
  kind: Exclude<NativeStateKind, "codex-rollout-v1">,
  id: string
): NativeThread {
  const path =
    kind === "claude-session-v1"
      ? `/home/runner/.claude/projects/-workspace/${id}.jsonl`
      : kind === "qwen-session-v1"
        ? `/home/runner/.qwen/sandlane/projects/-workspace/chats/${id}.jsonl`
        : `/home/runner/.local/state/opencode/sandlane/native/${id}.json`;
  return nativeThread({ kind, threadId: id, path }, kind);
}
export function nativeSnapshot(value: NativeSnapshot): NativeSnapshot {
  nativeThread(value);
  if (
    !/^[a-f0-9]{64}$/.test(value.containerId) ||
    !/^[a-f0-9-]{36}$/.test(value.brokerEpoch) ||
    !(value.data instanceof Uint8Array) ||
    !value.data.length ||
    value.data.length > NATIVE_STATE_BYTES
  )
    throw Error("NATIVE_STATE_INVALID");
  return value;
}
/** Header and raw file bytes. No archive extraction, JSON base64 expansion or vendor rewriting. */
export function encodeNative(header: object, data: Uint8Array): Buffer {
  if (data.length > NATIVE_STATE_BYTES) throw Error("NATIVE_STATE_LIMIT");
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > 8188) throw Error("NATIVE_STATE_LIMIT");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, data]);
}
export function decodeNative(body: Buffer): { header: Record<string, unknown>; data: Buffer } {
  if (body.length < 5 || body.length > NATIVE_BODY_BYTES) throw Error("NATIVE_STATE_INVALID");
  const length = body.readUInt32BE();
  if (length > 8188 || length + 4 >= body.length) throw Error("NATIVE_STATE_INVALID");
  const header: unknown = JSON.parse(body.subarray(4, 4 + length).toString("utf8"));
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw Error("NATIVE_STATE_INVALID");
  const data = body.subarray(4 + length);
  if (data.length > NATIVE_STATE_BYTES) throw Error("NATIVE_STATE_LIMIT");
  return { header: header as Record<string, unknown>, data };
}
