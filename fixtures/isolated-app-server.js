#!/usr/bin/env node
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
import readline from "node:readline";
import { readFile, writeFile } from "node:fs/promises";

// Both child processes intentionally use identical private thread/turn IDs.
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "same-thread" } } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "same-turn" } } });
    const prompt = m.params.input[0].text;
    if (prompt === "hang") continue;
    if (prompt === "oversized") { process.stdout.write("x".repeat(150_000)); continue; }
    let isolation;
    if (prompt.startsWith("isolation:")) {
      // Identical paths in concurrent containers must hold independent values.
      await writeFile("/workspace/probe", prompt, { flag: "wx" });
      await writeFile(`${process.env.HOME}/probe`, prompt, { flag: "wx" });
      let rootWriteDenied = false;
      try { await writeFile("/app/probe", prompt); } catch { rootWriteDenied = true; }
      await new Promise(resolve => setTimeout(resolve, 500));
      isolation = { workspaceValue: await readFile("/workspace/probe", "utf8"),
        homeValue: await readFile(`${process.env.HOME}/probe`, "utf8"), rootWriteDenied,
        uid: process.getuid(), status: await readFile("/proc/self/status", "utf8") };
    }
    send({ method: "item/agentMessage/delta", params: { threadId: "same-thread", delta: JSON.stringify({
      prompt, home: process.env.HOME, cwd: process.cwd(), secret: process.env.PUREFECT_TEST_SECRET ?? null, isolation }) } });
    send({ method: "turn/completed", params: { threadId: "same-thread", turn: { status: "completed" } } });
  }
}
