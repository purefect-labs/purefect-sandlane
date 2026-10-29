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
import { spawn, execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { createInterface } from "node:readline/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSecret } from "../dist/common/env.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const allowed = ["harness", "image", "model-origin", "model", "key-file", "messages-auth"];
const value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const clean = value =>
  stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
if (args.includes("--help")) {
  console.log(
    "npm run demo:chat -- --harness=codex|claude-code|qwen-code|opencode --image=repo@sha256:... --model-origin=https://... --model=... --key-file=/absolute/path [--messages-auth=x-api-key|bearer|both]\n真实模型单题问答；每题独立沙箱，无历史；/exit 退出，最多 16 题。会消耗模型额度。"
  );
  process.exit(0);
}
if (
  args.some(arg => !allowed.some(name => arg.startsWith(`--${name}=`))) ||
  allowed.some(name => args.filter(arg => arg.startsWith(`--${name}=`)).length > 1) ||
  !["codex", "claude-code", "qwen-code", "opencode"].includes(value("harness")) ||
  !/^.+@sha256:[a-f0-9]{64}$/.test(value("image") ?? "") ||
  !value("model") ||
  !path.isAbsolute(value("key-file") ?? "") ||
  !["x-api-key", "bearer", "both"].includes(value("messages-auth") ?? "x-api-key")
) {
  console.error("配置不完整或参数无效。请运行 npm run demo:chat -- --help。");
  process.exit(1);
}

let directory,
  reader,
  child,
  stopping = false;
const stop = () => {
  stopping = true;
  reader?.close();
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
async function runDemo(extra, consume = () => {}) {
  if (stopping) return 130;
  return new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [path.join(repository, "scripts/demo.js"), "--real", ...args, ...extra],
      {
        cwd: repository,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      const line = text => {
        if (text.startsWith("[demo]")) console.log(clean(text));
        consume(text);
      };
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          line(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
        if (pending.length > 1024 * 1024) stop();
      });
      stream.on("end", () => {
        if (pending) line(pending);
      });
    }
    child.once("error", reject);
    child.once("close", code => {
      child = undefined;
      resolve(code);
    });
  });
}
try {
  const origin = new URL(value("model-origin"));
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw Error("Invalid endpoint");
  // Validate the explicitly selected secret without printing or passing it in argv.
  await readSecret({ DEMO_KEY_FILE: value("key-file") }, "DEMO_KEY");
  const { stdout } = await promisify(execFile)("docker", ["image", "inspect", value("image")], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  const native = JSON.parse(stdout)[0];
  if (
    native.Id !== value("image").split("@")[1] &&
    !(native.RepoDigests ?? []).includes(value("image"))
  )
    throw Error("Image digest mismatch");
  const labels = native.Config?.Labels ?? {};
  if (
    labels["cn.purefect.sandlane.harness"] &&
    labels["cn.purefect.sandlane.harness"] !== value("harness")
  )
    throw Error("Image harness mismatch");
  const version = labels["cn.purefect.sandlane.cli-version"] ?? "未知（镜像未标注）";
  const metadata = `CLI: ${clean(value("harness"))} | 版本（镜像标签）: ${clean(version)} | 模型（配置标识）: ${clean(value("model"))}`;
  console.log(
    `SandLane 真实模型问答\n${metadata}\n上游: ${clean(origin.hostname)}\n镜像: ${clean(value("image"))}\n每题独立运行，不携带历史；模型别名不保证底层版本。真实调用会计费。\n输入 /exit 退出；Ctrl+C 停止并等待清理。首次构建可能较慢。`
  );
  directory = await mkdtemp(path.join(os.tmpdir(), "sandlane-chat-"));
  const promptFile = path.join(directory, "prompt.txt");
  console.log("先准备本次聊天镜像（不会调用模型），完成后再输入问题。");
  let ready = false;
  const preparation = Date.now();
  const prepareCode = await runDemo(["--prepare-only", `--prepared-dir=${directory}`], line => {
    if (line.startsWith("[demo] READY:")) ready = true;
  });
  if (prepareCode !== 0 || !ready || stopping) {
    process.exitCode = 1;
    console.error("镜像准备未完成，尚未提交问题或调用模型。请按上方构建阶段排查。");
  } else {
    console.log(
      `准备耗时 ${((Date.now() - preparation) / 1000).toFixed(1)} 秒；后续每题复用镜像。`
    );
    reader = createInterface({ input: process.stdin, output: process.stdout });
    reader.on("SIGINT", stop);
    reader.on("close", () => {
      stopping = true;
    });
    for (let turn = 0; turn < 16 && !stopping; ) {
      let prompt;
      try {
        prompt = await reader.question("\n你 > ");
      } catch {
        break;
      }
      if (stopping || prompt.trim() === "/exit") break;
      if (!prompt.trim()) continue;
      if (Buffer.byteLength(prompt) > 16_384) {
        console.log("问题不能超过 16 KiB，请缩短后重试。");
        continue;
      }
      turn++;
      await writeFile(promptFile, prompt, { mode: 0o600 });
      const started = Date.now();
      let result,
        cleanup = false;
      console.log("正在启动本题独立沙箱并调用模型（无需重新构建镜像）……");
      const consume = line => {
        if (line.startsWith("[demo]")) {
          if (line.startsWith("[demo] PASS:")) cleanup = true;
        }
        if (!line.startsWith("{")) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "demo.result") result = event;
        } catch {
          /* Ignore non-result diagnostics. */
        }
      };
      const code = await runDemo(
        [`--prepared-dir=${directory}`, `--prompt-file=${promptFile}`],
        consume
      );
      await rm(promptFile, { force: true });
      if (code !== 0 || !result || !cleanup) {
        console.error(
          "本次运行未成功或清理未确认；已停止，不自动重试。请检查上述诊断目录及模型配置。"
        );
        process.exitCode = 1;
        break;
      }
      console.log(
        `\n回答 >\n${clean(result.answer ?? "（无文本回答）")}\n\n${metadata}\n状态: ${clean(result.state)} | MCP 调用: ${result.toolCalls} | 总耗时（含启动和清理）: ${((Date.now() - started) / 1000).toFixed(1)} 秒`
      );
      if (result.usage)
        console.log(
          `Token（运行时报告）: 输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens}`
        );
      else console.log("Token 用量: 未报告；费用以模型服务商账单为准。");
    }
  }
} catch {
  console.error(
    "交互 Demo 启动失败：请检查 HTTPS 地址、受限 Key 文件和本地固定 digest 的 CLI 镜像。未输出凭据或原始错误内容。"
  );
  process.exitCode = 1;
} finally {
  reader?.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (directory) await rm(directory, { recursive: true, force: true });
}
