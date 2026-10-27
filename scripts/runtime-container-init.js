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
import { randomBytes } from "node:crypto";
import { mkdir, open, chown, chmod } from "node:fs/promises";

// One-off volume initialization. Existing secrets are retained; no secret enters Compose env/logs.
for (const directory of ["/config", "/host-config"]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chown(directory, 1000, 1000);
  await chmod(directory, 0o700);
}
async function credential(file, expected) {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(expected ?? randomBytes(32).toString("base64url"));
    await handle.chown(1000, 1000);
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally { await handle?.close(); }
  const { constants } = await import("node:fs");
  handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 1000 || (stat.mode & 0o077) || stat.size > 256) throw Error("Invalid credential file");
    const value = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || (expected && value !== expected)) throw Error("Credential mismatch");
    return value;
  } finally { await handle.close(); }
}
const broker = await credential("/config/broker-token");
await credential("/host-config/broker-token", broker);
console.log("Runtime credentials initialized; existing credentials preserved");
