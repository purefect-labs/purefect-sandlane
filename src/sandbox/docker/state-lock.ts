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
import { mkdir, lstat, writeFile, unlink, rmdir } from "node:fs/promises";
import path from "node:path";

/** A crash leaves a fail-closed lock. Operator must verify the prior service is stopped before recovery. */
export async function acquireStateLock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(stateDir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Broker state directory must be owned and private");
  const lock = path.join(stateDir, ".broker-lock");
  await mkdir(lock, { mode: 0o700 }); // Atomic across processes, even with different API sockets.
  const owner = path.join(lock, "owner.json");
  await writeFile(owner, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  let released = false;
  return async () => {
    if (released) return;
    await unlink(owner); await rmdir(lock); released = true;
  };
}
