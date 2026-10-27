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
import path from "node:path";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { readSecret } from "../../common/env.js";
import type { ContextProvider } from "../../spi/context.js";
import { MemoryContextProvider } from "./context-provider.js";
import { HttpSummarizer } from "./http-summarizer.js";
import { SqliteMemoryStore } from "./sqlite-store.js";
import { ConversationSummaries } from "./summary.js";

/** Optional local reference backend. Import dynamically so disabled users need no SQLite runtime. */
export async function openLocalMemory(directory: string, env: NodeJS.ProcessEnv) {
  if (env.SANDLANE_MEMORY_TOPOLOGY !== "single-host") throw new Error("MEMORY_SHARED_BACKEND_REQUIRED");
  const memoryDirectory = path.join(directory, "memory");
  await mkdir(memoryDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(memoryDirectory)).isDirectory()) throw new Error("MEMORY_DIRECTORY_INVALID");
  await chmod(memoryDirectory, 0o700);
  const filename = path.join(memoryDirectory, "memory.sqlite");
  try {
    if (!(await lstat(filename)).isFile()) throw new Error("MEMORY_FILE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hasModel = [
    "SANDLANE_MEMORY_SUMMARY_BASE_URL",
    "SANDLANE_MEMORY_SUMMARY_MODEL",
    "SANDLANE_MEMORY_SUMMARY_KEY",
    "SANDLANE_MEMORY_SUMMARY_KEY_FILE"
  ].some(key => !!env[key]);
  const model = hasModel
    ? new HttpSummarizer(
        env.SANDLANE_MEMORY_SUMMARY_BASE_URL ?? "",
        env.SANDLANE_MEMORY_SUMMARY_MODEL ?? "",
        await readSecret(env, "SANDLANE_MEMORY_SUMMARY_KEY")
      )
    : undefined;
  const store = new SqliteMemoryStore(filename);
  let summaries: ConversationSummaries;
  try {
    await chmod(filename, 0o600);
    summaries = new ConversationSummaries(store);
  } catch (error) {
    store.close();
    throw error;
  }
  const abort = new AbortController();
  const report = (code: string) => console.warn(code);
  const maintenance = (async () => {
    if (!model) {
      report("MEMORY_SUMMARY_MODEL_NOT_CONFIGURED");
      return;
    }
    while (!abort.signal.aborted) {
      try {
        const worked = await summaries.tick(model, abort.signal);
        await delay(worked ? 1000 : 5000, undefined, { signal: abort.signal });
      } catch {
        if (abort.signal.aborted) return;
        report("MEMORY_SUMMARY_MAINTENANCE_UNAVAILABLE");
        await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
      }
    }
  })();
  return {
    wrap: (inner: ContextProvider): ContextProvider =>
      new MemoryContextProvider(inner, store, summaries, report),
    close: async () => {
      abort.abort();
      await maintenance;
      store.close();
    }
  };
}
