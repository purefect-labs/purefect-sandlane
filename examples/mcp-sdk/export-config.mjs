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
import { pathToFileURL } from "node:url";
import { parseMcpConfig } from "@purefect/sandlane/plugins/mcp";
import { tools } from "./tools.mjs";

export function exportConfig(url, caFile) {
  // Use the actual Worker parser, not a second copy of its rules.
  return parseMcpConfig({
    servers: [
      { id: "crm", transport: { type: "http", url, ...(caFile ? { caFile } : {}) }, tools }
    ],
    bindings: []
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) throw Error("Usage: node export-config.mjs https://mcp.example/mcp [absolute-ca-file]");
  process.stdout.write(JSON.stringify(exportConfig(url, process.argv[3]), null, 2) + "\n");
}
