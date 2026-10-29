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
import test from "node:test";
import assert from "node:assert/strict";
import { buildImage } from "../scripts/demo-build.js";

test("build progress shows safe phases and hides raw dependency output", async () => {
  const lines = [];
  await buildImage(
    ["-e", 'console.error("#8 [build 4/6] RUN npm ci\\nprivate-token-do-not-print");'],
    {
      command: process.execPath,
      report: line => lines.push(line)
    }
  );
  assert.ok(lines.some(line => line.includes("安装 npm")));
  assert.ok(lines.some(line => line.includes("完成")));
  assert.ok(!lines.join("\n").includes("private-token"));
});

test("build failure preserves a fixed npm code, never arbitrary stderr", async () => {
  const lines = [];
  await assert.rejects(
    buildImage(
      ["-e", 'console.error("npm error code ENOTFOUND\\nprivate-password");process.exit(1)'],
      {
        command: process.execPath,
        report: line => lines.push(line)
      }
    ),
    error => error.message.includes("ENOTFOUND") && !error.message.includes("private-password")
  );
});

test("build timeout and cancellation terminate the child and reject without a success event", async () => {
  const lines = [];
  await assert.rejects(
    buildImage(["-e", "setInterval(()=>{},1000)"], {
      command: process.execPath,
      timeoutMs: 100,
      report: line => lines.push(line)
    }),
    /超时/
  );
  const abort = new AbortController();
  const pending = buildImage(["-e", "setInterval(()=>{},1000)"], {
    command: process.execPath,
    signal: abort.signal,
    report: line => lines.push(line)
  });
  abort.abort();
  await assert.rejects(pending, /取消/);
  assert.ok(!lines.some(line => line.includes("完成")));
});
