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
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";

test("simultaneous identical private IDs cannot mix Run events, homes or inherited secrets", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.PUREFECT_TEST_SECRET;
  process.env.PUREFECT_TEST_SECRET = "must-not-enter-child";
  t.after(() => { if (old === undefined) delete process.env.PUREFECT_TEST_SECRET; else process.env.PUREFECT_TEST_SECRET = old; });
  const adapters = ["a", "b"].map(id => new CodexRunAdapter({ home: path.join(root, id, "home"),
    workspace: path.join(root, id, "work"), command: process.execPath, args: [path.resolve("fixtures/isolated-app-server.js")] }));
  const streams = [[], []];
  adapters.forEach((a, i) => a.on("event", e => streams[i].push(e)));
  await Promise.all(adapters.map((a, i) => a.execute({ runId: `run-${i}`, prompt: `prompt-${i}`, expiresAt: Date.now() + 5000 })));
  for (let i = 0; i < 2; i++) {
    assert.equal(streams[i].at(-1).type, "run.completed");
    assert.ok(streams[i].every(e => e.runId === `run-${i}`));
    const data = JSON.parse(streams[i][0].data.delta);
    assert.equal(data.prompt, `prompt-${i}`); assert.equal(data.secret, null);
    assert.ok(data.home.includes(i === 0 ? "/a/" : "/b/"));
  }
  await assert.rejects(adapters[0].execute({ runId: "new", prompt: "no", expiresAt: Date.now() + 5000 }), /cannot be reused/);
});

test("deadline cancellation and oversized output terminate the child", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-adapter-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const prompt of ["hang", "oversized"]) {
    const adapter = new CodexRunAdapter({ home: path.join(root, prompt, "home"), workspace: path.join(root, prompt, "work"),
      command: process.execPath, args: [path.resolve("fixtures/isolated-app-server.js")] });
    const events = []; adapter.on("event", e => events.push(e));
    await adapter.execute({ runId: prompt, prompt, expiresAt: Date.now() + (prompt === "hang" ? 250 : 5000) });
    assert.equal(events.at(-1).type, prompt === "hang" ? "run.cancelled" : "run.failed");
    assert.equal(events.filter(e => e.type.startsWith("run.")).length, 1);
  }
});
