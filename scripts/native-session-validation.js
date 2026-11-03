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

/** Fixed-image, offline native resume experiment. No production credentials or paid upstream.
 * Run after npm run build, with NATIVE_SESSION_IMAGE set to an immutable local image ID.
 * Uses disposable internal-network containers; this is not a Broker/Worker integration test.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionProcesses } from "../dist/sandbox/docker/session-processes.js";
import { nativeCommand } from "../dist/sandbox/docker/session-native.js";
import { NATIVE_STATE_BYTES } from "../dist/common/native-session.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";
import { LocalProcessTransport } from "../dist/harness/codex/local-process-transport.js";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { codexManagedConfig } from "../dist/harness/codex/codex-managed-config.js";

const image = process.env.NATIVE_SESSION_IMAGE;
assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "Pin NATIVE_SESSION_IMAGE to a local image ID");
const exec = promisify(execFile);
const command = (args, options = {}) =>
  exec("docker", args, {
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
const context = (
  await command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
).stdout.trim();
assert.ok(context.startsWith("unix://"), "A local Docker Unix socket is required");
const docker = new DockerEngine(context.slice(7));
const root = await mkdtemp(path.join(tmpdir(), "sandlane-native-session-"));
const project = fileURLToPath(new URL("../", import.meta.url));
const name = `sandlane-native-session-${randomUUID()}`;
const containers = [];
const processes = [];
const users = ["first", "second", "third", "driver"].map(id => ({
  id,
  model: randomBytes(32).toString("base64url"),
  tool: randomBytes(32).toString("base64url")
}));
let network, upstream;
const report = { image, mode: "isolated-real-model-gateway", checks: {}, passed: false };

function rpc(container, user) {
  const managed = codexManagedConfig({
    modelAlias: "fixture-model",
    toolServer: "fixture",
    modelBaseUrl: "https://gateway.test:9443/v1",
    mcpUrl: "https://gateway.test:9444/mcp",
    modelCapability: user.model,
    toolCapability: user.tool,
    enabledTools: user.id === "first" ? ["read"] : ["read", "extra"]
  });
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      ...Object.entries(managed.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      container,
      "/usr/local/bin/codex",
      ...managed.args,
      "-c",
      "features.memories=false",
      "-c",
      "model_auto_compact_token_limit=20000",
      "app-server"
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  processes.push(child);
  let sequence = 0,
    buffer = "",
    size = 0,
    exited = false;
  const pending = new Map(),
    events = [];
  const closed = new Promise(resolve =>
    child.once("close", code => {
      exited = true;
      for (const waiter of pending.values()) waiter.reject(Error("CLI exited"));
      resolve(code);
    })
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  child.stdout.on("data", chunk => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      child.kill();
      return;
    }
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else events.push(message);
    }
  });
  return {
    events,
    async request(method, params) {
      assert.ok(!exited, "CLI already exited");
      const id = ++sequence;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(Error(`RPC deadline: ${method}`)), 20000);
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ method }) + "\n");
    },
    async completed(offset = 0) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const event = events.slice(offset).find(event => event.method === "turn/completed");
        if (event) return event.params;
        if (exited) throw Error("CLI exited before turn completion");
        await delay(25);
      }
      throw Error("Turn completion deadline");
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        return await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const logs = async () =>
  (await command(["logs", upstream])).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
const files = async container => {
  const { stdout } = await command([
    "exec",
    container,
    "find",
    "/home/runner/.codex",
    "-type",
    "f"
  ]);
  return stdout.trim().split("\n").filter(Boolean).sort();
};

try {
  // The certificate is fixture-only and never trusted outside these containers.
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=gateway.test",
    "-addext",
    "subjectAltName=DNS:gateway.test",
    "-keyout",
    path.join(root, "key.pem"),
    "-out",
    path.join(root, "cert.pem")
  ]);
  network = (
    await docker.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Internal: true,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }
    })
  ).Id;
  upstream = (
    await docker.request("POST", "/containers/create", {
      Image: image,
      User: "1000:1000",
      Entrypoint: ["node"],
      Cmd: ["/app/scripts/fixtures/native-session-gateways.mjs"],
      Env: [
        `FIXTURE=${JSON.stringify({
          users,
          key: await readFile(path.join(root, "key.pem"), "utf8"),
          cert: await readFile(path.join(root, "cert.pem"), "utf8")
        })}`
      ],
      HostConfig: {
        NetworkMode: network,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
        Binds: ["dist", "scripts/fixtures"].map(dir => `${path.join(project, dir)}:/app/${dir}:ro`)
      }
    })
  ).Id;
  containers.push(upstream);
  await docker.request("POST", `/containers/${upstream}/start`);
  const info = await docker.request("GET", `/containers/${upstream}/json`);
  const ip = Object.values(info.NetworkSettings.Networks)[0].IPAddress;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if ((await logs()).some(line => line.kind === "ready")) {
      ready = true;
      break;
    }
    await delay(50);
  }
  assert.ok(ready, "Fixture did not start");
  const container = (
    await docker.request("POST", "/containers/create", {
      Image: image,
      User: "1000:1000",
      Entrypoint: ["sleep"],
      Cmd: ["infinity"],
      WorkingDir: "/workspace",
      Env: [
        "HOME=/home/runner",
        "CODEX_HOME=/home/runner/.codex",
        "SSL_CERT_FILE=/fixture-ca.pem",
        "NODE_EXTRA_CA_CERTS=/fixture-ca.pem"
      ],
      HostConfig: {
        NetworkMode: network,
        ExtraHosts: [`gateway.test:${ip}`],
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 128,
        Binds: [`${path.join(root, "cert.pem")}:/fixture-ca.pem:ro`],
        Tmpfs: {
          "/tmp": "rw,nosuid,nodev,size=64m,mode=1777",
          "/home/runner/.codex": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
          "/workspace": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000"
        }
      }
    })
  ).Id;
  containers.push(container);
  await docker.request("POST", `/containers/${container}/start`);
  report.version = (
    await command(["exec", container, "/usr/local/bin/codex", "--version"])
  ).stdout.trim();
  assert.equal(report.version, "codex-cli 0.154.0");
  const first = rpc(container, users[0]);
  const initialized = await first.request("initialize", {
    clientInfo: { name: "native-session-probe", version: "1" },
    capabilities: {}
  });
  report.userAgent = initialized.userAgent;
  first.notify("initialized");
  const start = await first.request("thread/start", {
    cwd: "/workspace",
    ephemeral: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "first-instructions-marker",
    developerInstructions: "first-developer-marker"
  });
  const threadId = start.thread.id;
  await first.request("turn/start", {
    threadId,
    effort: "low",
    input: [{ type: "text", text: "Use the fixture read tool and finish.", text_elements: [] }]
  });
  const firstEnd = await first.completed();
  assert.equal(firstEnd.turn.status, "completed");
  const beforeExit = await files(container);
  const rollout = beforeExit.filter(file =>
    /^\/home\/runner\/\.codex\/sessions\/.+\.jsonl$/.test(file)
  );
  assert.equal(rollout.length, 1, "Expected one rollout file");
  const readRollout = async () => (await command(["exec", container, "cat", rollout[0]])).stdout;
  const atCompleted = await readRollout();
  assert.ok(atCompleted.includes("native-history-proof-7f4a"));
  report.checks.rolloutAtTurnCompleted = true;
  report.checks.firstExitCode = await first.close();
  const afterExit = await readRollout();
  report.checks.rolloutStableAfterExit = atCompleted === afterExit;
  report.stateFileCount = (await files(container)).length;
  for (const user of users)
    for (const token of [user.model, user.tool])
      assert.ok(!afterExit.includes(token), "Capability in rollout");
  report.checks.noLiteralCapabilityInRollout = true;
  const stateThread = { kind: "codex-rollout-v1", threadId, path: rollout[0] };
  const processes = new SessionProcesses(docker);
  const exportState = async () => {
    const result = await processes.read(
      container,
      nativeCommand(stateThread),
      NATIVE_STATE_BYTES,
      Date.now() + 5000,
      AbortSignal.timeout(5000)
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.complete, true);
    return result.stdout;
  };
  const restoreState = async bytes => {
    await docker.request("POST", `/containers/${container}/stop?t=0`);
    await docker.request("POST", `/containers/${container}/start`);
    assert.deepEqual(await files(container), []);
    await processes.extract(
      container,
      [bytes],
      Date.now() + 5000,
      AbortSignal.timeout(5000),
      nativeCommand(stateThread, true)
    );
  };
  const snapshot = await exportState();
  report.snapshotBytes = snapshot.length;
  await restoreState(snapshot);
  const second = rpc(container, users[1]);
  await second.request("initialize", {
    clientInfo: { name: "native-session-probe", version: "1" },
    capabilities: {}
  });
  second.notify("initialized");
  const resumed = await second.request("thread/resume", {
    threadId,
    cwd: "/workspace",
    model: "fixture-model",
    modelProvider: "sandlane",
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "second-instructions-marker",
    developerInstructions: "second-developer-marker"
  });
  assert.equal(resumed.thread.id, threadId);
  report.resume = {
    path: resumed.thread.path,
    model: resumed.model,
    modelProvider: resumed.modelProvider,
    cwd: resumed.cwd,
    approvalPolicy: resumed.approvalPolicy
  };
  await delay(250);
  const beforeTurn = await logs();
  assert.ok(
    !beforeTurn.some(
      line => line.run === "second" && (line.kind === "upstream" || line.method === "tools/call")
    )
  );
  report.checks.noResumeSideEffects = true;
  await second.request("turn/start", {
    threadId,
    effort: "high",
    input: [
      {
        type: "text",
        text: "Recall the earlier tool result without calling it again.",
        text_elements: []
      }
    ]
  });
  assert.equal((await second.completed()).turn.status, "completed");
  const records = await logs();
  const request = records.find(line => line.kind === "upstream" && line.run === "second")?.body;
  assert.ok(request, "Second Run did not reach the validated upstream");
  assert.ok(request.input.some(item => item.type === "function_call"));
  assert.ok(
    request.input.some(
      item =>
        item.type === "function_call_output" &&
        JSON.stringify(item).includes("native-history-proof-7f4a")
    )
  );
  report.checks.nativeToolHistoryRestored = true;
  assert.ok(request.instructions.includes("second-instructions-marker"));
  assert.ok(!request.instructions.includes("first-instructions-marker"));
  assert.equal(request.reasoning.effort, "high");
  assert.ok(JSON.stringify(request.tools).includes('"extra"'));
  report.checks.currentSettings = true;
  report.requestBytes = Buffer.byteLength(JSON.stringify(request));
  const eventOffset = second.events.length;
  await second.request("thread/compact/start", { threadId });
  assert.equal((await second.completed(eventOffset)).turn.status, "completed");
  const compactRecords = (await logs()).slice(records.length);
  report.compaction = {
    http: compactRecords.filter(record => record.kind === "http"),
    events: second.events.slice(eventOffset).map(event => ({
      method: event.method,
      itemType: event.params?.item?.type,
      status: event.params?.turn?.status
    })),
    errors: second.events
      .slice(eventOffset)
      .filter(event => event.method === "error")
      .map(event => event.params?.error?.message ?? "CLI error")
  };
  report.checks.compactionGatewayCompatible =
    !report.compaction.http.some(record => record.status >= 400) &&
    second.events
      .slice(eventOffset)
      .some(
        event =>
          event.method === "item/completed" && event.params?.item?.type === "contextCompaction"
      );
  const compacted = await readRollout();
  assert.ok(compacted.includes('"type":"compacted"'), "Compaction was not persisted");
  const compactSnapshot = await exportState();
  await second.close();
  await restoreState(compactSnapshot);
  const third = rpc(container, users[2]);
  await third.request("initialize", {
    clientInfo: { name: "native-session-probe", version: "1" },
    capabilities: {}
  });
  third.notify("initialized");
  await third.request("thread/resume", {
    threadId,
    cwd: "/workspace",
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "third-instructions-marker",
    config: { model_auto_compact_token_limit: 64, "features.memories": false }
  });
  await third.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Continue after compaction.", text_elements: [] }]
  });
  assert.equal((await third.completed()).turn.status, "completed");
  const thirdRequest = (await logs()).find(
    line => line.kind === "upstream" && line.run === "third"
  )?.body;
  assert.ok(thirdRequest);
  assert.ok(!thirdRequest.input.some(item => item.type === "function_call"));
  assert.ok(
    JSON.stringify(thirdRequest.input).includes("done-second"),
    "Compacted summary was not restored"
  );
  report.checks.compactedHistoryRestored = true;
  for (let turn = 4; turn <= 12; turn++) {
    const offset = third.events.length;
    await third.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Fixture continuation ${turn}.`, text_elements: [] }]
    });
    assert.equal((await third.completed(offset)).turn.status, "completed");
  }
  report.checks.twelveTurns = true;
  assert.ok(
    third.events.some(
      event => event.method === "item/completed" && event.params?.item?.type === "contextCompaction"
    ),
    "Automatic compaction was not exercised"
  );
  report.checks.automaticCompaction = true;
  report.rolloutBytesAfterTwelveTurns = Buffer.byteLength(await readRollout());
  const finalSnapshot = await exportState();
  await third.close();
  await restoreState(finalSnapshot);
  const managed = codexManagedConfig({
    modelAlias: "fixture-model",
    toolServer: "fixture",
    modelBaseUrl: "https://gateway.test:9443/v1",
    mcpUrl: "https://gateway.test:9444/mcp",
    modelCapability: users[3].model,
    toolCapability: users[3].tool,
    enabledTools: ["read", "extra"]
  });
  const driver = new CodexRunAdapter({
    workspace: "/workspace",
    transport: new LocalProcessTransport({
      command: "docker",
      args: [
        "--host",
        context,
        "exec",
        "-i",
        ...Object.entries(managed.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        container,
        "/usr/local/bin/codex",
        ...managed.args,
        "app-server"
      ],
      workspace: root,
      home: root,
      env: { PATH: process.env.PATH, HOME: root }
    })
  });
  let captured = false,
    completed = false;
  driver.on("event", event => {
    if (event.type === "run.completed") completed = true;
    if (event.type === "run.failed") report.driverFailure = event.data;
  });
  await driver.execute({
    runId: "probe-driver",
    prompt: "fallback-must-not-be-submitted",
    instructions: "driver-instructions-marker",
    expiresAt: Date.now() + 20000,
    nativeSession: {
      resume: stateThread,
      prompt: "driver-current-turn-marker",
      promptFormat: "text",
      capture: async thread => {
        assert.deepEqual(thread, stateThread);
        await exportState();
        captured = true;
      }
    }
  });
  const driverRequest = (await logs()).find(
    line => line.kind === "upstream" && line.run === "driver"
  )?.body;
  report.driver = { completed, captured };
  assert.ok(completed && captured, "Production Driver did not complete and capture native state");
  assert.ok(JSON.stringify(driverRequest.input).includes("done-third"));
  assert.ok(JSON.stringify(driverRequest.input).includes("driver-current-turn-marker"));
  assert.ok(!JSON.stringify(driverRequest.input).includes("fallback-must-not-be-submitted"));
  assert.ok(driverRequest.instructions.includes("driver-instructions-marker"));
  report.checks.productionDriverResume = true;
  // The helper must refuse a substituted symlink, even though the runner can write this area.
  await command(["exec", container, "mv", rollout[0], rollout[0] + ".saved"]);
  await command(["exec", container, "ln", "-s", "/etc/passwd", rollout[0]]);
  const rejected = await processes.read(
    container,
    nativeCommand(stateThread),
    NATIVE_STATE_BYTES,
    Date.now() + 5000,
    AbortSignal.timeout(5000)
  );
  assert.notEqual(rejected.exitCode, 0);
  assert.equal(rejected.stdout.length, 0);
  report.checks.symlinkRejected = true;
  report.passed =
    report.checks.nativeToolHistoryRestored &&
    report.checks.currentSettings &&
    report.checks.compactionGatewayCompatible &&
    report.checks.compactedHistoryRestored;
} catch (error) {
  report.error = String(error.message).slice(0, 1500);
} finally {
  for (const child of processes) child.kill("SIGKILL");
  for (const container of containers.reverse())
    await docker.request("DELETE", `/containers/${container}?force=true`).catch(() => {});
  if (network) await docker.request("DELETE", `/networks/${network}`).catch(() => {});
  await rm(root, { recursive: true, force: true });
  // Never emit fixture capabilities, raw requests or state contents.
  let output = JSON.stringify(report, null, 2);
  for (const user of users)
    for (const token of [user.model, user.tool]) output = output.replaceAll(token, "[redacted]");
  console.log(output);
  if (!report.passed) process.exitCode = 1;
}
