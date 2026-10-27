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
/** Memory-aware claim admission: a lane claims a Run only while the host has at least the
 * configured amount of memory available (a typical sandbox peak plus a safety reserve). Container
 * memory limits are ceilings, not reservations, so concurrency is not fixed: an idle host runs
 * more Runs, a loaded one defers claiming instead of taking a Run it cannot run. The check runs
 * before the claim, so a claimed Run is never given back. */
import { readFile } from "node:fs/promises";

/** `MemAvailable` of a /proc/meminfo text in bytes; undefined when absent or malformed. */
export function parseMemAvailable(text: string): number | undefined {
  const match = /^MemAvailable:\s+([0-9]{1,15})\s+kB$/m.exec(text);
  return match ? Number(match[1]) * 1024 : undefined;
}

/** Host available memory from /proc/meminfo (the host's view also inside a container); undefined
 * where it cannot be read (e.g. not Linux). */
export async function readMemAvailable(file = "/proc/meminfo"): Promise<number | undefined> {
  try {
    return parseMemAvailable(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export type AdmissionVerdict = "admit" | "low" | "unknown";

export class MemoryAdmission {
  constructor(
    /** Bytes that must be available before claiming; 0 disables the check. */
    private readonly minAvailableBytes: number,
    private readonly read: () => Promise<number | undefined> = readMemAvailable
  ) {
    if (!Number.isSafeInteger(minAvailableBytes) || minAvailableBytes < 0)
      throw new Error("INVALID_ADMISSION_CONFIGURATION");
  }

  /** `low`: below the threshold, defer the claim. `unknown`: the reading failed; the lane admits
   * (the check is a capacity hint, and an unreadable host must not stop every lane). */
  async check(): Promise<AdmissionVerdict> {
    if (this.minAvailableBytes === 0) return "admit";
    let available: number | undefined;
    try {
      available = await this.read();
    } catch {
      available = undefined;
    }
    if (available === undefined || !Number.isFinite(available)) return "unknown";
    return available >= this.minAvailableBytes ? "admit" : "low";
  }
}
