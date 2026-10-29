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

import { readFile, stat } from "node:fs/promises";
import { readSecret } from "../dist/common/env.js";
import { probeModel } from "./model-compatibility-lib.js";

if (process.argv.length !== 3) {
  console.error("Usage: npm run models:check -- /absolute/path/profiles.json");
  process.exit(1);
}
try {
  const file = process.argv[2];
  if ((await stat(file)).size > 65536) throw Error();
  const profiles = JSON.parse(await readFile(file, "utf8"));
  if (
    !Array.isArray(profiles) ||
    !profiles.length ||
    profiles.length > 16 ||
    profiles.some(p => !p || !/^[a-z0-9-]{1,64}$/.test(p.id)) ||
    new Set(profiles.map(p => p.id)).size !== profiles.length
  )
    throw Error();
  for (const profile of profiles) {
    try {
      const secret = await readSecret({ MODEL_KEY_FILE: profile.keyFile }, "MODEL_KEY");
      const result = await probeModel(profile, secret);
      console.log(
        JSON.stringify({ id: profile.id, status: "PASS", scope: "provider-protocol", ...result })
      );
    } catch (error) {
      process.exitCode = 1;
      // Providers may carry raw remote bodies; never print bodies, URLs, paths or secrets.
      const code =
        typeof error?.message === "string" &&
        /^(MODEL_|PROBE_|INVALID_PROBE_)[A-Z_]+$/.test(error.message)
          ? error.message
          : "PROBE_FAILED";
      console.log(
        JSON.stringify({
          id: profile.id,
          status: "FAIL",
          code,
          ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {})
        })
      );
    }
  }
} catch {
  console.error("INVALID_PROBE_CONFIG");
  process.exitCode = 1;
}
