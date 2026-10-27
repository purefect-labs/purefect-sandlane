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
/** Checks of an operator-configured model function inventory (functions the model gateway admits
 * per Harness). */

/**
 * The required functions an explicit inventory lacks, as `harness:function`. Only Harnesses the
 * inventory lists are checked: one it leaves out gets no functions at all, which is the
 * operator's choice. A missing function makes the model gateway reject every request of that
 * Harness's Runs whose CLI offers the tool, so such an inventory must not start.
 */
export function missingFunctions(
  inventory: Readonly<Record<string, readonly string[]>>,
  required: Readonly<Record<string, readonly string[]>>
): string[] {
  const missing: string[] = [];
  for (const [harness, names] of Object.entries(required)) {
    if (!Object.hasOwn(inventory, harness)) continue;
    const listed = new Set(inventory[harness]);
    for (const name of names) if (!listed.has(name)) missing.push(`${harness}:${name}`);
  }
  return missing;
}
