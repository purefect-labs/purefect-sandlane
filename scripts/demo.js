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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, copyFile, chmod, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildImage } from "./demo-build.js";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "npm run demo -- [--scenario=success|cancel|lease-loss]\n" +
      "Real CLI: --real --harness=codex|claude-code|qwen-code|opencode --image=repo@sha256:... --model-origin=https://.../v1 --model=... --messages-auth=x-api-key|bearer|both --key-file=/absolute/path --prompt-file=/absolute/path"
  );
  process.exit(0);
}
const value = name => args.find(arg => arg.startsWith("--" + name + "="))?.slice(name.length + 3);
const allowed = [
  "scenario",
  "harness",
  "image",
  "model-origin",
  "messages-auth",
  "model",
  "key-file",
  "prompt-file",
  "prepared-dir"
];
if (
  args.some(
    arg =>
      !["--real", "--prepare-only"].includes(arg) &&
      !allowed.some(name => arg.startsWith("--" + name + "="))
  )
)
  throw Error("Unknown demo argument");
const mode = args.includes("--real") ? "real" : "fixture";
const prepareOnly = args.includes("--prepare-only");
const preparedDir = value("prepared-dir");
if ((prepareOnly && !preparedDir) || (preparedDir && !path.isAbsolute(preparedDir)))
  throw Error("Preparation requires an absolute session directory");
const scenario = value("scenario") ?? "success",
  harness = mode === "fixture" ? "claude-code" : value("harness");
if (
  !["success", "cancel", "lease-loss"].includes(scenario) ||
  !["codex", "claude-code", "qwen-code", "opencode"].includes(harness)
)
  throw Error("Invalid demo scenario or harness");
if (mode === "real" && scenario !== "success") throw Error("Fault scenarios use fixture mode");
const messagesAuth = value("messages-auth") ?? "x-api-key";
if (!["x-api-key", "bearer", "both"].includes(messagesAuth))
  throw Error("Invalid Messages authentication mode");
if (
  mode === "real" &&
  (!/^.+@sha256:[a-f0-9]{64}$/.test(value("image") ?? "") ||
    !value("model") ||
    !value("model-origin") ||
    !path.isAbsolute(value("key-file") ?? "") ||
    (!prepareOnly && !path.isAbsolute(value("prompt-file") ?? "")))
)
  throw Error(
    "Real mode requires pinned image, model, HTTPS origin, absolute key-file and prompt-file"
  );
const run = async (command, argv, options = {}) => {
  try {
    const { stdout } = await exec(command, argv, {
      cwd: repository,
      timeout: 300_000,
      maxBuffer: 12 * 1024 * 1024,
      ...options
    });
    return stdout.trim();
  } catch (error) {
    // Never echo argv or environment; real mode can contain private upstream addresses.
    throw new Error(
      command + " failed: " + (error.stderr?.slice(-3000) ?? error.code ?? "unknown")
    );
  }
};
const buildStop = new AbortController();
const docker = async (...argv) => {
  if (argv[0] !== "build") return run("docker", argv);
  try {
    await buildImage(["build", "--progress=plain", ...argv.slice(1)], {
      cwd: repository,
      signal: buildStop.signal
    });
    return "";
  } catch (error) {
    console.error("[demo] " + error.message);
    throw Error("DEMO_BUILD_FAILED");
  }
};
const id = "sandlane-demo-" + randomBytes(6).toString("hex");
const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-demo-"));
const overrideFile = path.join(root, "compose.generated.json");
const compose = (...argv) =>
  docker(
    "compose",
    "-p",
    id,
    "-f",
    path.join(repository, "deploy/compose.demo.yaml"),
    "-f",
    overrideFile,
    ...argv
  );
let registryId,
  composeCreated = false,
  passed = false;
let interruption = false;
const interrupt = () => {
  interruption = true;
  buildStop.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function main() {
  try {
    const prepared =
      preparedDir && !prepareOnly
        ? JSON.parse(await readFile(path.join(preparedDir, "prepared.json"), "utf8"))
        : undefined;
    if (
      prepared &&
      (prepared.mode !== mode ||
        prepared.scenario !== scenario ||
        prepared.harness !== harness ||
        prepared.native !== value("image") ||
        !Number.isSafeInteger(prepared.expiresAt) ||
        prepared.expiresAt <= Date.now() ||
        !/^sha256:[a-f0-9]{64}$/.test(prepared.runtimeImage) ||
        !/^sha256:[a-f0-9]{64}$/.test(prepared.relayImage) ||
        !/^127\.0\.0\.1:\d+\/sandlane-cli@sha256:[a-f0-9]{64}$/.test(prepared.cliImage))
    )
      throw Error("Invalid or expired prepared images");
    const version = await docker("version", "--format", "{{.Server.Version}}");
    if (Number(version.split(".")[0]) < 28) throw Error("Docker Engine 28 or newer required");
    await docker("compose", "version");
    const networkIds = (await docker("network", "ls", "-q")).split("\n").filter(Boolean);
    const networks = networkIds.length
      ? JSON.parse(await docker("network", "inspect", ...networkIds))
      : [];
    const occupied = networks.flatMap(n =>
      (n.IPAM?.Config ?? []).map(c => c.Subnet).filter(Boolean)
    );
    const ipv4 = text => text.split(".").reduce((n, v) => n * 256 + Number(v), 0);
    const overlaps = (a, b) => {
      if (!b.includes(".")) return false;
      const [aa, ap] = a.split("/"),
        [ba, bp] = b.split("/");
      const as = 2 ** (32 - Number(ap)),
        bs = 2 ** (32 - Number(bp));
      const al = Math.floor(ipv4(aa) / as) * as,
        bl = Math.floor(ipv4(ba) / bs) * bs;
      return al < bl + bs && bl < al + as;
    };
    const subnet = [
      ...Array.from({ length: 16 }, (_, i) => "172." + (16 + i) + ".240.0/24"),
      ...Array.from({ length: 50 }, (_, i) => "10." + (200 + i) + ".240.0/24")
    ].find(
      candidate =>
        !occupied.some(other => overlaps(candidate, other)) &&
        !Object.values(os.networkInterfaces())
          .flat()
          .some(iface => iface?.family === "IPv4" && iface.cidr && overlaps(candidate, iface.cidr))
    );
    if (!subnet) throw Error("No unused demo subnet");
    const workerIp = subnet.replace("0/24", "10");
    if (prepared && mode === "fixture" && prepared.workerIp !== workerIp)
      throw Error("Fixture subnet changed; prepare fixture images again");
    const fixtureDir = path.join(root, "fixture");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(fixtureDir);
    if (prepared) {
      for (const file of ["gateway-ca.pem", "gateway.pem", "gateway-key.pem"])
        await copyFile(path.join(preparedDir, file), path.join(root, file));
    } else {
      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=SandLane Demo CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        path.join(root, "ca-key.pem"),
        "-out",
        path.join(root, "gateway-ca.pem")
      ]);
      await run("openssl", [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=model.demo.test",
        "-keyout",
        path.join(root, "gateway-key.pem"),
        "-out",
        path.join(root, "gateway.csr")
      ]);
      await writeFile(
        path.join(root, "gateway.ext"),
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:model.demo.test,DNS:tools.demo.test,IP:127.0.0.1\n",
        { mode: 0o600 }
      );
      await run("openssl", [
        "x509",
        "-req",
        "-in",
        path.join(root, "gateway.csr"),
        "-CA",
        path.join(root, "gateway-ca.pem"),
        "-CAkey",
        path.join(root, "ca-key.pem"),
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        path.join(root, "gateway.ext"),
        "-out",
        path.join(root, "gateway.pem")
      ]);
      await rm(path.join(root, "ca-key.pem"), { force: true });
    }
    await chmod(path.join(root, "gateway-key.pem"), 0o600);
    await writeFile(path.join(root, "broker-token"), randomBytes(32).toString("base64url"), {
      mode: 0o600
    });
    const config = { mode, scenario, harness, nodeId: id, messagesAuth };
    if (mode === "real" && !prepareOnly) {
      const origin = new URL(value("model-origin"));
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash
      )
        throw Error("Invalid HTTPS model origin");
      config.modelOrigin = origin.href;
      config.model = value("model");
      config.prompt = await readFile(value("prompt-file"), "utf8");
      if (Buffer.byteLength(config.prompt) > 16384) throw Error("Demo prompt exceeds 16 KiB");
      await copyFile(value("key-file"), path.join(root, "model-key"));
      await chmod(path.join(root, "model-key"), 0o600);
    }
    await writeFile(path.join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    let runtimeImage = prepared?.runtimeImage,
      relayImage = prepared?.relayImage,
      cliImage = prepared?.cliImage;
    if (!prepared) {
      console.log("[demo] 准备 runtime、relay 和 CLI 镜像；此阶段不会调用模型");
      await docker("build", "-f", "deploy/Dockerfile.runtime", "-t", id + ":runtime", ".");
      await docker("build", "-f", "deploy/Dockerfile.relay", "-t", id + ":relay", ".");
      const baseMatch = (
        await readFile(path.join(repository, "deploy/Dockerfile.runtime"), "utf8")
      ).match(/^ARG NODE_IMAGE=(.+)$/m);
      const base = baseMatch[1];
      await copyFile(path.join(root, "gateway-ca.pem"), path.join(fixtureDir, "gateway-ca.crt"));
      await copyFile(path.join(repository, "LICENSE"), path.join(fixtureDir, "LICENSE"));
      await copyFile(path.join(repository, "NOTICE"), path.join(fixtureDir, "NOTICE"));
      if (mode === "fixture") {
        await copyFile(
          path.join(repository, "fixtures/demo-cli.mjs"),
          path.join(fixtureDir, "demo-cli.mjs")
        );
        await writeFile(
          path.join(fixtureDir, "probe.json"),
          JSON.stringify({ workerIp, scenario })
        );
        await writeFile(
          path.join(fixtureDir, "Dockerfile"),
          [
            "FROM " + base,
            "WORKDIR /app",
            "COPY LICENSE NOTICE ./",
            "COPY probe.json ./",
            "COPY demo-cli.mjs /usr/local/bin/claude",
            "COPY gateway-ca.crt /etc/ssl/certs/ca-certificates.crt",
            "RUN chmod 755 /usr/local/bin/claude",
            "USER 1000:1000",
            ""
          ].join("\n")
        );
        await docker("build", "-t", id + ":cli", fixtureDir);
      } else {
        await copyFile(
          path.join(repository, "deploy/Dockerfile.cli-ca"),
          path.join(fixtureDir, "Dockerfile")
        );
        // Resolve the explicitly pinned local image first. BuildKit may otherwise try to pull
        // private/local-only digests even when Docker already has the exact approved image.
        const native = JSON.parse(await docker("image", "inspect", value("image")))[0];
        const expected = value("image").split("@")[1];
        if (native.Id !== expected && !(native.RepoDigests ?? []).includes(value("image")))
          throw Error("Native CLI image does not match the requested digest");
        await docker("tag", native.Id, id + ":native");
        await docker(
          "build",
          "--build-arg",
          "NATIVE_CLI_IMAGE=" + id + ":native",
          "-t",
          id + ":cli",
          fixtureDir
        );
      }
      // A local registry provides a real RepoDigest for the derived CLI image.
      console.log("[demo] 将 CLI 镜像登记为固定 digest（本地临时 registry）");
      // Bind on the daemon host's loopback. Desktop port forwarding on the client host is not
      // necessarily reachable from the daemon's own loopback during docker push.
      const port = String(40000 + (randomBytes(2).readUInt16BE() % 20000));
      registryId = await docker(
        "run",
        "-d",
        "--name",
        id + "-registry",
        "--label",
        "demo.sandlane.owner=" + id,
        "--network",
        "host",
        "-e",
        "REGISTRY_HTTP_ADDR=127.0.0.1:" + port,
        "registry:2"
      );
      let registryReady = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await docker(
            "exec",
            registryId,
            "wget",
            "-q",
            "-O",
            "-",
            "http://127.0.0.1:" + port + "/v2/"
          );
          registryReady = true;
          break;
        } catch {
          /* Port publishing and the registry listener become ready asynchronously. */
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!registryReady) throw Error("Local image registry did not become ready");
      const cliTag = "127.0.0.1:" + port + "/sandlane-cli:" + id;
      await docker("tag", id + ":cli", cliTag);
      await docker("push", cliTag);
      await docker("pull", cliTag);
      cliImage = JSON.parse(await docker("image", "inspect", cliTag))[0].RepoDigests.find(v =>
        v.startsWith("127.0.0.1:" + port + "/")
      );
      if (!cliImage) throw Error("CLI RepoDigest missing");
      runtimeImage = JSON.parse(await docker("image", "inspect", id + ":runtime"))[0].Id;
      relayImage = JSON.parse(await docker("image", "inspect", id + ":relay"))[0].Id;
    } else {
      // Fail before copying credentials into containers if a prepared image was pruned.
      for (const image of [runtimeImage, relayImage, cliImage])
        await docker("image", "inspect", image);
      console.log("[demo] 复用本次聊天已准备的镜像；创建本题独立运行环境");
    }
    if (interruption) throw Error("Demo interrupted before execution");
    if (prepareOnly) {
      for (const file of ["gateway-ca.pem", "gateway.pem", "gateway-key.pem"])
        await copyFile(path.join(root, file), path.join(preparedDir, file));
      await chmod(path.join(preparedDir, "gateway-key.pem"), 0o600);
      await writeFile(
        path.join(preparedDir, "prepared.json"),
        JSON.stringify({
          mode,
          scenario,
          workerIp,
          harness,
          native: value("image"),
          runtimeImage,
          relayImage,
          cliImage,
          expiresAt: Date.now() + 12 * 60 * 60 * 1000
        }),
        { mode: 0o600 }
      );
      passed = true;
      return;
    }
    const routes = JSON.stringify(
      [19443, 19444].map(p => ({
        listenHost: "0.0.0.0",
        listenPort: p,
        upstreamHost: workerIp,
        upstreamPort: p
      }))
    );
    const digest = createHash("sha256").update(routes).digest("hex");
    const socket = process.env.DOCKER_HOST?.startsWith("unix://")
      ? process.env.DOCKER_HOST.slice(7)
      : "/var/run/docker.sock";
    const socketGid =
      process.platform === "linux"
        ? String((await (await import("node:fs/promises")).stat(socket)).gid)
        : "0";
    const override = {
      services: {
        init: { image: runtimeImage, volumes: [root + ":/seed:ro"] },
        relay: {
          image: relayImage,
          environment: { SANDLANE_RELAY_ROUTES: routes },
          labels: {
            "demo.sandlane.relay.node": id,
            "demo.sandlane.relay.policy": digest
          }
        },
        broker: {
          image: runtimeImage,
          group_add: [socketGid],
          environment: {
            SANDLANE_BROKER_NODE_ID: id,
            SANDLANE_BROKER_RUN_IMAGES: JSON.stringify({ [harness]: cliImage }),
            SANDLANE_BROKER_MANAGED_GATEWAYS: JSON.stringify({
              modelBaseUrl: "https://model.demo.test:19443/v1",
              mcpUrl: "https://tools.demo.test:19444/mcp"
            })
          }
        },
        execution: { image: runtimeImage, networks: { gateways: { ipv4_address: workerIp } } }
      },
      networks: { gateways: { internal: mode === "fixture", ipam: { config: [{ subnet }] } } }
    };
    await writeFile(overrideFile, JSON.stringify(override), { mode: 0o600 });
    await compose("config", "--quiet");
    composeCreated = true;
    await compose("up", "--no-build", "--exit-code-from", "init", "init");
    await compose("up", "-d", "--no-build", "relay");
    const relayId = await compose("ps", "-q", "relay");
    const relay = JSON.parse(await docker("inspect", relayId))[0];
    override.services.broker.environment.SANDLANE_BROKER_RELAY_BINDING = JSON.stringify({
      containerId: relay.Id,
      imageId: relay.Image,
      policyDigest: digest
    });
    await writeFile(overrideFile, JSON.stringify(override), { mode: 0o600 });
    console.log("[demo] Starting Broker, pinned Relay and managed Worker");
    await compose("up", "-d", "--no-build", "--wait", "broker");
    if (interruption) throw Error("Demo interrupted before execution");
    await compose("up", "-d", "--no-build", "execution");
    const executionId = await compose("ps", "-q", "execution");
    const deadline = Date.now() + (mode === "fixture" ? 120_000 : 720_000);
    let state;
    while (true) {
      state = JSON.parse(await docker("inspect", executionId))[0].State;
      if (!state.Running) break;
      if (interruption || Date.now() > deadline) {
        await docker("stop", "-t", "50", executionId);
        throw Error("Demo interrupted or timed out");
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const logs = await docker("logs", executionId);
    console.log(logs);
    if (state.ExitCode !== 0 || !logs.includes('"type":"demo.result"'))
      throw Error("Demo execution failed");
    passed = true;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    // Diagnostic retention never needs the copied provider key.
    await rm(path.join(root, "model-key"), { force: true });
    await rm(path.join(root, "ca-key.pem"), { force: true });
    if (composeCreated) {
      try {
        await compose("stop", "execution");
        await compose("stop", "broker");
        const leftovers = await docker("ps", "-aq", "--filter", "label=demo.sandlane.broker=" + id);
        const runNetworks = await docker(
          "network",
          "ls",
          "-q",
          "--filter",
          "label=demo.sandlane.broker=" + id
        );
        if (leftovers || runNetworks) {
          passed = false;
          console.error(
            "[demo] Broker cleanup incomplete; retaining state volumes and directory: " + root
          );
          await compose("down", "--timeout", "60");
        } else await compose("down", "--volumes", "--timeout", "60");
      } catch {
        passed = false;
        console.error("[demo] Cleanup incomplete; retained state directory: " + root);
      }
    }
    if (registryId) {
      try {
        await docker("rm", "-f", "-v", registryId);
      } catch {
        passed = false;
      }
    }
    if (passed) {
      await rm(root, { recursive: true, force: true });
      console.log(
        prepareOnly
          ? "[demo] READY: 镜像准备完成；本次聊天后续问题不再构建镜像"
          : "[demo] PASS: execution verified; demo containers, networks and volumes removed"
      );
    } else console.error("[demo] Not passed; diagnostic directory: " + root);
  }
}
try {
  await main();
} catch {
  console.error("[demo] Demo 未完成；请检查上面的阶段提示及诊断目录，不自动重试模型请求。");
}
if (!passed) process.exitCode = 1;
