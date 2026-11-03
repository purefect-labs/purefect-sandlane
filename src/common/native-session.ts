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

/** Bounded opaque Codex rollout, never a credential/configuration directory or archive. */
export const NATIVE_STATE_BYTES = 1024 * 1024;
export const NATIVE_BODY_BYTES = NATIVE_STATE_BYTES + 8192;
export interface NativeThread {
  readonly threadId: string;
  readonly path: string;
}
export interface NativeSnapshot extends NativeThread {
  readonly containerId: string;
  readonly brokerEpoch: string;
  readonly data: Uint8Array;
}
export function nativeThread(value: unknown): NativeThread {
  const v = value as NativeThread;
  if (
    !v ||
    typeof v.threadId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.threadId) ||
    typeof v.path !== "string" ||
    !new RegExp(
      "^/home/runner/\\.codex/sessions/[0-9]{4}/[0-9]{2}/[0-9]{2}/rollout-[0-9T:-]{19}-" +
        v.threadId +
        "\\.jsonl$"
    ).test(v.path)
  )
    throw Error("NATIVE_STATE_INVALID");
  return { threadId: v.threadId, path: v.path };
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
