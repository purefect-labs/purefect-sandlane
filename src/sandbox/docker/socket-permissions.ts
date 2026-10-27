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
import { lstat } from "node:fs/promises";
import path from "node:path";

/** Shared by startup and read-only preflight; sharing this directory never grants Docker access. */
export async function requireSocketDirectory(socketPath: string, groupId?: number): Promise<void> {
  if (!socketPath.startsWith("/")) throw new Error("Absolute Broker socket path required");
  const parent = await lstat(path.dirname(socketPath));
  const groupMode = groupId !== undefined;
  if (
    groupMode &&
    (!Number.isSafeInteger(groupId) || groupId < 1 || !process.getgroups?.().includes(groupId))
  ) {
    throw new Error("Broker socket group must be an explicit supplementary process group");
  }
  const safePermissions = groupMode
    ? parent.gid === groupId && (parent.mode & 0o027) === 0 && (parent.mode & 0o010) !== 0
    : (parent.mode & 0o077) === 0;
  if (!parent.isDirectory() || !safePermissions || parent.uid !== process.getuid?.()) {
    throw new Error(
      "Broker socket parent must be owned and private, or traverse-only for the configured group"
    );
  }
}
