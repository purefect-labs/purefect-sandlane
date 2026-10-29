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
import { readdir, copyFile, chmod, chown, mkdir } from "node:fs/promises";
for (const directory of ["/demo", "/control", "/state"]) {
  await mkdir(directory, { recursive: true });
  await chown(directory, 1000, 1000);
  await chmod(directory, 0o700);
}
for (const name of await readdir("/seed")) {
  if (
    ![
      "config.json",
      "gateway.pem",
      "gateway-ca.pem",
      "gateway-key.pem",
      "broker-token",
      "model-key"
    ].includes(name)
  )
    continue;
  const target = "/demo/" + name;
  await copyFile("/seed/" + name, target);
  await chown(target, 1000, 1000);
  await chmod(target, 0o600);
}
