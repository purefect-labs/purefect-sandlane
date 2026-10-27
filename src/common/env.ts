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
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export function required(env: Env, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value)
    throw new Error(`${key} is required without surrounding whitespace`);
  return value;
}

/** File credentials preferred. Never return their values in health/preflight output. */
export async function readSecret(env: Env, key: string): Promise<string> {
  const file = env[`${key}_FILE`];
  const inline = env[key];
  if (file && inline) throw new Error(`Configure only ${key}_FILE or ${key}, not both`);
  let value = inline;
  if (file) {
    if (!path.isAbsolute(file)) throw new Error(`${key}_FILE must be absolute`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 4096 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error(`${key}_FILE must be an owned private regular file (0600/0400)`);
      value = (await handle.readFile("utf8")).trim();
    } finally {
      await handle.close();
    }
  }
  if (!value || !/^[\x21-\x7E]{32,256}$/.test(value))
    throw new Error(`${key} must be 32..256 printable ASCII characters without whitespace`);
  return value;
}
