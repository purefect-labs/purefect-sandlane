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
/** Disposable native CLI wire experiment. No provider or business credentials.
 * Direct isolated Docker network here tests protocol/TLS, not Broker authorization.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";
import { LocalProcessTransport } from "../dist/harness/codex/local-process-transport.js";
import { codexManagedConfig } from "../dist/harness/codex/codex-managed-config.js";
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";
import { startNativeCliBroker } from "./fixtures/native-cli-broker.mjs";

const image = process.env.DOCKER_TEST_IMAGE;
assert.match(image ?? "", /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const socket = process.env.DOCKER_TEST_SOCKET;
assert.ok(socket?.startsWith("/"));
const docker = new DockerEngine(socket);
const brokerMode = process.argv.includes("--broker");
const gateways = brokerMode || process.argv.includes("--gateways");
const project = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const root = await mkdtemp("/private/tmp/sandlane-native-protocol-");
const context = path.join(root, "context");
await mkdir(context);
const id = `sandlane-protocol-${randomUUID()}`;
const containers = [];
let network, derivedImage, localBase, brokerLane;
const report = {
  passed: false,
  mode: brokerMode ? "broker-relay-gateways" : gateways ? "gateway-components" : "wire-fixture",
  checks: [],
  requests: [],
  runs: []
};
const command = (args, options = {}) =>
  exec("docker", ["--host", `unix://${socket}`, ...args], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    ...options
  });
const openssl = args => exec("openssl", args, { cwd: root, timeout: 10000 });

// Runs inside the disposable upstream container. Never emits credentials or prompts.
function fixture() {
  const https = require("node:https");
  const config = JSON.parse(process.env.FIXTURE);
  const records = [];
  https
    .createServer({ key: config.key, cert: config.cert }, async (req, res) => {
      const user = config.users.find(
        u => req.headers.authorization === `Bearer ${req.url === "/mcp" ? u.tool : u.model}`
      );
      if (!user) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 256000) {
          res.destroy();
          return;
        }
      }
      const body = JSON.parse(data);
      if (req.url === "/mcp") {
        console.log(JSON.stringify({ kind: "mcp", user: user.id, method: body.method }));
        let result;
        if (body.method === "initialize")
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" }
          };
        else if (body.method === "tools/list")
          result = {
            tools: [
              {
                name: "metadata_read",
                description: "Read fixture metadata",
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                inputSchema: { type: "object", properties: {}, additionalProperties: false }
              }
            ]
          };
        else if (body.method === "tools/call") {
          if (body.params.name !== "metadata_read") {
            res.writeHead(403);
            res.end();
            return;
          }
          result = { content: [{ type: "text", text: `fixture-user-${user.id}` }] };
        } else {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      if (req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end();
        return;
      }
      // Requests contain only fixture data; retained privately for parser validation.
      console.log(JSON.stringify({ kind: "model", user: user.id, body }));
      const second = records.includes(user.id);
      records.push(user.id);
      const namespace = body.tools?.find(t => t.type === "namespace" && t.name === "mcp__purefect");
      const tool =
        namespace?.tools?.find(t => t.name?.includes("metadata_read")) ??
        body.tools?.find(t => t.name?.includes("metadata_read"));
      const item = second
        ? {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: `done-${user.id}`, annotations: [] }]
          }
        : {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call_fixture",
            name: tool?.name ?? "missing_tool",
            ...(namespace ? { namespace: namespace.name } : {}),
            arguments: "{}",
            status: "completed"
          };
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sequence = 0;
      const send = event =>
        res.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
      send({
        type: "response.created",
        response: { id: "resp_fixture", status: "in_progress", output: [] }
      });
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, ...(second ? { content: [] } : { arguments: "" }) }
      });
      if (second)
        send({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: `done-${user.id}`
        });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      });
      res.end();
    })
    .listen(9443, "0.0.0.0", () => console.log(JSON.stringify({ kind: "ready" })));
}

try {
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Purefect disposable fixture CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    "ca.key",
    "-out",
    "context/gateway-ca.crt"
  ]);
  await openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=gateway.test",
    "-keyout",
    "server.key",
    "-out",
    "server.csr"
  ]);
  await writeFile(
    path.join(root, "extensions"),
    "subjectAltName=DNS:gateway.test\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n"
  );
  await openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "context/gateway-ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "extensions",
    "-out",
    "server.crt"
  ]);
  await copyFile(
    fileURLToPath(new URL("../deploy/Dockerfile.cli-ca", import.meta.url)),
    path.join(context, "Dockerfile")
  );
  // Locally built RepoDigests need not exist in a registry. Verify the pinned
  // source first, then give BuildKit a disposable local alias for that exact ID.
  const source = await docker.request("GET", `/images/${encodeURIComponent(image)}/json`);
  assert.ok(source.RepoDigests.includes(image));
  localBase = `${id}-base`;
  await command(["tag", source.Id, localBase]);
  await command([
    "build",
    "--pull=false",
    "--build-arg",
    `NATIVE_CLI_IMAGE=${localBase}`,
    "--tag",
    id,
    context
  ]);
  derivedImage = id;
  const net = await docker.request("POST", "/networks/create", {
    Name: id,
    Driver: "bridge",
    Internal: true,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }
  });
  network = net.Id;
  const users = ["untrusted", "a", "b"].map(id => ({
    id,
    model: randomBytes(32).toString("base64url"),
    tool: randomBytes(32).toString("base64url")
  }));
  const upstream = await docker.request("POST", "/containers/create", {
    Image: image,
    User: "1000:1000",
    Entrypoint: ["node"],
    Cmd: gateways
      ? ["/app/scripts/fixtures/native-cli-gateways.mjs"]
      : ["-e", `(${fixture.toString()})()`],
    Env: [
      `FIXTURE=${JSON.stringify({ users, key: await readFile(path.join(root, "server.key"), "utf8"), cert: await readFile(path.join(root, "server.crt"), "utf8") })}`
    ],
    HostConfig: {
      NetworkMode: network,
      // Read-only code mounts belong solely to disposable Gateway infrastructure.
      // The native CLI containers below never receive these mounts.
      ...(gateways
        ? {
            Binds: ["dist", "node_modules", "scripts/fixtures"].map(
              dir => `${path.join(project, dir)}:/app/${dir}:ro`
            )
          }
        : {}),
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 128 * 1024 * 1024,
      PidsLimit: 64
    }
  });
  containers.push(upstream.Id);
  await docker.request("POST", `/containers/${upstream.Id}/start`);
  const upstreamInfo = await docker.request("GET", `/containers/${upstream.Id}/json`);
  const ip = Object.values(upstreamInfo.NetworkSettings.Networks)[0].IPAddress;
  if (brokerMode)
    brokerLane = await startNativeCliBroker({
      docker,
      image: derivedImage,
      relayImage: process.env.DOCKER_RELAY_IMAGE,
      network,
      upstreamIp: ip,
      root,
      nodeId: id,
      containers
    });
  const execute = async user => {
    const name = `${id}-${user.id}`;
    const useBroker = brokerMode && user.id !== "untrusted";
    if (!useBroker) containers.push(name);
    const managed = codexManagedConfig({
      modelAlias: "fixture",
      toolServer: "purefect",
      modelBaseUrl: "https://gateway.test:9443/v1",
      modelCapability: user.model,
      mcpUrl: `https://gateway.test:${gateways ? 9444 : 9443}/mcp`,
      toolCapability: user.tool,
      enabledTools: [
        gateways ? (user.id === "b" ? "metadata.get_meta" : "metadata.get_raw") : "metadata_read"
      ]
    });
    const args = [
      "--host",
      `unix://${socket}`,
      "run",
      "--name",
      name,
      "--network",
      network,
      "--add-host",
      `gateway.test:${ip}`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
      "-e",
      "HOME=/tmp",
      "-e",
      "CODEX_HOME=/tmp",
      "-e",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "-e",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      ...Object.entries(managed.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-i",
      user.id === "untrusted" ? image : derivedImage,
      "app-server",
      ...managed.args
    ];
    const expiresAt = Date.now() + 15000;
    const adapter = new CodexRunAdapter({
      workspace: "/workspace",
      transport: useBroker
        ? await brokerLane.transport(user, expiresAt)
        : new LocalProcessTransport({
            command: "docker",
            args,
            workspace: root,
            home: root,
            env: { PATH: process.env.PATH, HOME: root }
          })
    });
    const events = [];
    adapter.on("event", event => events.push(event));
    await adapter.execute({
      runId: `run-${user.id}`,
      prompt: "Use metadata_read once then reply done.",
      expiresAt
    });
    report.runs.push({
      user: user.id,
      eventTypes: events.map(e => e.type),
      completed: events.some(e => e.type === "run.completed")
    });
    if (useBroker) assert.equal(adapter.stopEvidence?.state, "exited");
    if (!useBroker && user.id !== "untrusted" && !report.runs.at(-1).completed) {
      const logs = await command(["logs", name]);
      report.runs.at(-1).diagnostic = (logs.stdout + logs.stderr).slice(-6000);
      for (const identity of users)
        for (const token of [identity.model, identity.tool])
          report.runs.at(-1).diagnostic = report.runs
            .at(-1)
            .diagnostic.replaceAll(token, "[redacted]");
    }
  };
  await execute(users[0]);
  // Keep failed peers observed until they also settle, so cleanup never races an active Run.
  const runs = await Promise.allSettled(users.slice(1).map(execute));
  for (const result of runs) if (result.status === "rejected") throw result.reason;
  const { stdout } = await command(["logs", upstream.Id]);
  for (const line of stdout.trim().split("\n")) {
    const record = JSON.parse(line);
    if (record.kind !== "model") {
      report.checks.push(record);
      continue;
    }
    const names = [
      gateways
        ? `mcp__purefect.metadata_get_${record.user === "b" ? "meta" : "raw"}`
        : "mcp__purefect.metadata_read"
    ];
    let accepted = true;
    try {
      parseResponsesRequest(record.body, names, 1024);
    } catch {
      accepted = false;
    }
    report.requests.push({
      user: record.user,
      toolHistory: record.body.input?.filter(
        i => i.type === "function_call" || i.type === "function_call_output"
      ),
      fields: Object.keys(record.body),
      tools: record.body.tools?.map(t => ({ type: t.type, name: t.name, tools: t.tools })),
      accepted
    });
  }
  assert.equal(report.runs.length, 3);
  assert.equal(report.runs[0].completed, false, "Untrusted CA must fail");
  assert.ok(!report.checks.some(c => c.user === "untrusted"));
  assert.ok(!report.requests.some(c => c.user === "untrusted"));
  assert.ok(
    report.runs.slice(1).every(r => r.completed),
    "Native CLI did not complete"
  );
  assert.equal(report.requests.length, 4);
  if (gateways) {
    assert.equal(
      report.checks.filter(c => c.kind === "model-receipt" && c.outcome === "SUCCEEDED").length,
      4
    );
    assert.equal(report.checks.filter(c => c.kind === "model-published").length, 4);
    assert.equal(
      report.checks.filter(c => c.kind === "tool-receipt" && c.outcome === "SUCCEEDED").length,
      2
    );
  }
  assert.ok(
    report.requests.every(r => r.accepted),
    "Native requests must pass strict Gateway validation"
  );
  for (const user of users.slice(1)) {
    assert.ok(report.checks.some(c => c.user === user.id && c.method === "tools/call"));
    const history = report.requests.filter(r => r.user === user.id).flatMap(r => r.toolHistory);
    const outputs = JSON.stringify(history.filter(i => i.type === "function_call_output"));
    assert.ok(outputs.includes(`fixture-user-${user.id}`));
    assert.ok(!outputs.includes(`fixture-user-${user.id === "a" ? "b" : "a"}`));
  }
  report.passed = true;
} finally {
  const cleanupErrors = [];
  const clean = async (label, action) => {
    try {
      return await action();
    } catch {
      cleanupErrors.push(label);
    }
  };
  if (brokerLane) report.brokerCleanup = await clean("broker", () => brokerLane.close());
  for (const container of containers.reverse())
    await command(["rm", "--force", container]).catch(() => cleanupErrors.push(container));
  if (network)
    await clean("upstream-network", () => docker.request("DELETE", `/networks/${network}`));
  if (derivedImage) await clean("derived-image", () => command(["image", "rm", derivedImage]));
  if (localBase) await clean("base-alias", () => command(["image", "rm", localBase]));
  // Delete only disposable certificate/private-key artifacts created by this script.
  for (const file of ["ca.key", "server.key", "server.csr", "server.crt", "extensions"])
    await clean(file, () => rm(path.join(root, file), { force: true }));
  await clean("build-context", () => rm(context, { recursive: true, force: true }));
  report.cleanupErrors = cleanupErrors;
  report.passed &&= cleanupErrors.length === 0;
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600
  });
  console.log(
    JSON.stringify(
      {
        report: path.join(root, "report.json"),
        passed: report.passed,
        runs: report.runs,
        requests: report.requests.length,
        allRequestsAccepted: report.requests.every(r => r.accepted),
        cleanupErrors
      },
      null,
      2
    )
  );
  assert.equal(cleanupErrors.length, 0, "Test containers could not be removed");
}
