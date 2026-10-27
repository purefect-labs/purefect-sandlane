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
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";

// Offline integration fixture only: this trusted test process has Docker access.
// Production Worker/Driver must use an authenticated Broker, not this test adapter.
const image = process.env.DOCKER_TEST_IMAGE;
assert.match(image ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const engine = new DockerEngine(process.env.DOCKER_TEST_SOCKET ?? "");
const metadata = await engine.request("GET", `/images/${encodeURIComponent(image)}/json`);
assert.ok(metadata.RepoDigests?.includes(image));
assert.equal(Object.keys(metadata.Config?.Volumes ?? {}).length, 0);
const owner = `attach-validation-${randomUUID()}`;
const label = "validation.sandlane.attach";
const containers = new Set();
const timings = [];
const checks = [];
const root = await mkdtemp(
  path.join(
    process.platform === "darwin" ? "/private/tmp" : os.tmpdir(),
    "sandlane-attach-validation-"
  )
);
const check = name => {
  checks.push(name);
  console.log(`PASS ${name}`);
};

async function create() {
  const started = performance.now();
  const response = await engine.request(
    "POST",
    `/containers/create?name=${owner}-${randomUUID()}`,
    {
      Image: image,
      Entrypoint: ["/usr/local/bin/codex"],
      Cmd: ["app-server"],
      User: "1000:1000",
      WorkingDir: "/workspace",
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      Env: [
        "HOME=/home/runner",
        "CODEX_HOME=/home/runner/.codex",
        "PATH=/usr/local/bin:/usr/bin:/bin"
      ],
      Labels: { [label]: owner },
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 64,
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,nodev,size=16m,mode=1777",
          "/workspace": "rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700",
          "/home/runner": "rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700"
        },
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
        LogConfig: { Type: "none" }
      }
    }
  );
  assert.match(response.Id, /^[a-f0-9]{64}$/);
  containers.add(response.Id);
  const inspected = await engine.request("GET", `/containers/${response.Id}/json`);
  assert.equal(inspected.Config.Labels[label], owner);
  timings.push({ operation: "create", ms: performance.now() - started });
  return response.Id;
}

async function execute(prompt) {
  const id = await create();
  const expiresAt = Date.now() + 30_000;
  let channel,
    pump,
    stopping = false;
  const transport = {
    async start(observer) {
      // Attach before start to avoid losing the first native protocol bytes.
      const started = performance.now();
      channel = await engine.attach(id, expiresAt, new AbortController().signal);
      pump = (async () => {
        try {
          for await (const chunk of channel.output) observer.stdout(chunk);
        } catch {
          if (!stopping) observer.fault();
        }
      })();
      await engine.request("POST", `/containers/${id}/start`);
      timings.push({ operation: "attach-and-start", ms: performance.now() - started });
    },
    write(frame) {
      return channel.write(frame);
    },
    async stop() {
      stopping = true;
      channel?.close();
      await engine.request("POST", `/containers/${id}/stop?t=1`);
      const info = await engine.request("GET", `/containers/${id}/json`);
      await pump;
      // Actual inspection, not stream EOF or a successful kill request, supplies evidence.
      if (info.State.Running !== false || !Number.isSafeInteger(info.State.ExitCode))
        return { state: "unknown" };
      return { state: "exited", code: info.State.ExitCode, signal: null };
    }
  };
  const driver = new CodexRunAdapter({ workspace: "/workspace", transport });
  const events = [];
  driver.on("event", event => events.push(event));
  await driver.execute({ runId: `r-${randomUUID()}`, prompt, expiresAt });
  assert.equal(driver.stopEvidence.state, "exited");
  assert.equal(events.at(-1).type, "run.completed");
  const output = JSON.parse(events.find(event => event.type === "message.delta").data.delta);
  assert.equal(output.prompt, prompt);
  assert.equal(output.isolation.workspaceValue, prompt);
  assert.equal(output.isolation.homeValue, prompt);
  assert.equal(output.isolation.rootWriteDenied, true);
  assert.equal(output.secret, null);
  assert.equal(output.isolation.uid, 1000);
}

let passed = false;
try {
  const results = await Promise.allSettled([
    execute("isolation:外置Driver-A🙂"),
    execute("isolation:外置Driver-B🙂")
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  check("external-driver-concurrent-native-protocol-and-private-filesystems");
  const id = await create();
  const channel = await engine.attach(id, Date.now() + 30_000, new AbortController().signal);
  await engine.request("POST", `/containers/${id}/start`);
  channel.close();
  assert.equal((await engine.request("GET", `/containers/${id}/json`)).State.Running, true);
  check("attach-disconnect-is-not-container-stop");
  passed = true;
} finally {
  // Remove only exact IDs created here, and recheck ownership before removal.
  for (const id of containers) {
    const info = await engine.request("GET", `/containers/${id}/json`);
    assert.equal(info.Config.Labels[label], owner);
    await engine.request("DELETE", `/containers/${id}?force=true&v=true`);
  }
  const filter = encodeURIComponent(JSON.stringify({ label: [`${label}=${owner}`] }));
  const remaining = await engine.request("GET", `/containers/json?all=true&filters=${filter}`);
  assert.equal(remaining.length, 0);
  const report = {
    schemaVersion: 1,
    passed,
    image,
    checks,
    timings,
    remainingContainers: remaining.length,
    scope:
      "offline fixture; host Driver and native container protocol over real Docker attach; no production Broker endpoint, real model or MCP"
  };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Report: ${root}/report.json`);
}
