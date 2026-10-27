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
import { execFileSync } from "node:child_process";

const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
);
const report = JSON.parse(output)[0];
const files = report?.files?.map(entry => entry.path);
if (!Array.isArray(files) || files.length < 1) throw new Error("Invalid npm pack report");

const roots = new Set(["LICENSE", "NOTICE", "README.md", "package.json"]);
const prefixes = ["contract/", "dist/", "docs/"];
const unexpected = files.filter(
  file => !roots.has(file) && !prefixes.some(prefix => file.startsWith(prefix))
);
if (unexpected.length) throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);

for (const required of [
  "LICENSE",
  "NOTICE",
  "dist/runtime/runtime.js",
  "dist/runtime/runtime.d.ts",
  "contract/ai-execution-v1.schema.json"
]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
}

console.log(`Validated ${files.length} package files`);
