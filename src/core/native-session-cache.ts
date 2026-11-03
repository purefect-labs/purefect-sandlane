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
  NATIVE_STATE_BYTES,
  nativeSnapshot,
  type NativeSnapshot
} from "../common/native-session.js";

export interface NativeCachePolicy {
  key: string;
  tenant: string;
  runNo: number;
  fingerprint: string;
  contracts: Readonly<Record<string, string>>;
}
interface Entry extends NativeCachePolicy {
  snapshot: NativeSnapshot;
  born: number;
  expires: number;
}
export interface NativeCacheUse {
  readonly snapshot?: NativeSnapshot;
  invalidate(): void;
  finish(snapshot?: NativeSnapshot, restored?: boolean): void;
}
/** Process-local optimization, not a lease authority. A checked-out entry is never available
 * to another Run. Reserve 8 MiB per active capture for file/HTTP/decoder copies as well as the
 * old snapshot; this keeps transfer buffers inside the same 32 MiB budget as idle entries. */
export class NativeSessionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, { token: symbol; tenant: string }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly now = Date.now) {
    this.timer = setInterval(() => this.prune(), 1000);
    this.timer.unref();
  }
  private prune(): void {
    for (const [key, entry] of this.entries)
      if (entry.expires <= this.now()) this.entries.delete(key);
  }
  invalidate(key: string): void {
    this.entries.delete(key);
    // Invalidates publication, but the reservation stays until its owner finishes.
    const active = this.active.get(key);
    if (active) active.token = Symbol();
  }
  begin(policy: NativeCachePolicy): NativeCacheUse | undefined {
    this.prune();
    if (this.closed || !Number.isSafeInteger(policy.runNo) || policy.runNo < 1) return undefined;
    if (this.active.has(policy.key)) {
      this.invalidate(policy.key);
      return undefined;
    }
    const previous = this.entries.get(policy.key);
    this.entries.delete(policy.key);
    const compatible =
      previous &&
      previous.runNo + 1 === policy.runNo &&
      previous.fingerprint === policy.fingerprint &&
      Object.entries(previous.contracts).every(
        ([name, contract]) => policy.contracts[name] === contract
      );
    const usage = (tenant?: string) =>
      [...this.entries.values()].reduce(
        (n, e) => n + (!tenant || e.tenant === tenant ? e.snapshot.data.byteLength + 32768 : 0),
        0
      ) +
      [...this.active.values()].filter(e => !tenant || e.tenant === tenant).length *
        8 *
        NATIVE_STATE_BYTES;
    while (
      usage() + 8 * NATIVE_STATE_BYTES > 32 * NATIVE_STATE_BYTES ||
      usage(policy.tenant) + 8 * NATIVE_STATE_BYTES > 16 * NATIVE_STATE_BYTES
    ) {
      const key = this.entries.keys().next().value;
      if (key === undefined) return undefined;
      this.entries.delete(key);
    }
    const token = Symbol();
    this.active.set(policy.key, { token, tenant: policy.tenant });
    let done = false;
    let published: Entry | undefined;
    return {
      ...(compatible ? { snapshot: previous.snapshot } : {}),
      invalidate: () => {
        if (this.active.get(policy.key)?.token === token)
          this.active.get(policy.key)!.token = Symbol();
        if (published && this.entries.get(policy.key) === published)
          this.entries.delete(policy.key);
      },
      finish: (snapshot, restored = false) => {
        if (done) return;
        done = true;
        const valid = this.active.get(policy.key)?.token === token;
        this.active.delete(policy.key);
        if (!valid || this.closed || !snapshot) return;
        try {
          nativeSnapshot(snapshot);
        } catch {
          return;
        }
        const born = compatible && restored ? previous.born : this.now();
        const expires = Math.min(born + 60 * 60_000, this.now() + 300_000);
        if (expires <= this.now()) return;
        published = { ...policy, contracts: { ...policy.contracts }, snapshot, born, expires };
        this.entries.set(policy.key, published);
      }
    };
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.entries.clear();
    // In-flight owners retain their reservations and will discard their candidates.
    for (const value of this.active.values()) value.token = Symbol();
  }
}
