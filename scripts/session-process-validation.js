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
// Disposable native CLI validation. No model calls or business MCP credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { SessionProcesses } from "../dist/sandbox/docker/session-processes.js";

const image = process.env.DOCKER_TEST_IMAGE;
assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
const engine = new DockerEngine(process.env.DOCKER_TEST_SOCKET ?? "");
const name = `sandlane-session-validation-${randomUUID()}`;
const created = await engine.request("POST", `/containers/create?name=${name}`, {
  Image: image,
  User: "1000:1000",
  WorkingDir: "/workspace",
  Entrypoint: ["/bin/sleep"],
  Cmd: ["infinity"],
  Env: ["HOME=/home/runner", "CODEX_HOME=/home/runner/.codex", "PATH=/usr/local/bin:/usr/bin:/bin"],
  HostConfig: {
    NetworkMode: "none",
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Memory: 512 * 1024 * 1024,
    PidsLimit: 128,
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,nodev,size=32m",
      "/workspace": "rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
      "/home/runner": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
      "/home/runner/.codex": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000"
    }
  }
});
const samples = [];
try {
  for (let turn = 0; turn < 2; turn++) {
    await engine.request("POST", `/containers/${created.Id}/start`);
    const processes = new SessionProcesses(engine);
    const began = performance.now();
    const execId = await processes.create(
      created.Id,
      ["/usr/local/bin/codex", "app-server"],
      [`SANDLANE_VALIDATION_TURN=${turn}`]
    );
    const channel = await engine.startExec(execId, Date.now() + 15000, AbortSignal.timeout(15000));
    try {
      await channel.write(
        Buffer.from(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "session-validation", version: "1" } }
          }) + "\n"
        )
      );
      let buffer = "";
      let initialized = false;
      for await (const chunk of channel.output) {
        buffer += chunk.toString("utf8");
        if (
          buffer.split("\n").some(line => {
            try {
              const value = JSON.parse(line);
              return value.id === 1 && value.result;
            } catch {
              return false;
            }
          })
        ) {
          initialized = true;
          break;
        }
      }
      assert.equal(initialized, true);
    } finally {
      channel.close();
    }
    const initializeMs = performance.now() - began;
    const stopBegan = performance.now();
    await processes.stop(created.Id);
    const info = await engine.request("GET", `/containers/${created.Id}/json`);
    assert.equal(info.State.Running, false);
    assert.equal(info.Id, created.Id);
    samples.push({
      turn,
      initializeMs: Math.round(initializeMs),
      stopMs: Math.round(performance.now() - stopBegan)
    });
  }
  console.log(JSON.stringify({ passed: true, sameContainer: true, samples }));
} finally {
  await engine.request("DELETE", `/containers/${created.Id}?force=true&v=true`);
}
