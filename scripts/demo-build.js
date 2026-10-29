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
import { spawn } from "node:child_process";

// Report fixed phase names, never raw dependency output, argv, secrets or upstream errors.
export async function buildImage(
  args,
  {
    cwd,
    signal,
    timeoutMs = 300000,
    report = line => console.log("[demo] " + line),
    command = "docker"
  } = {}
) {
  signal?.throwIfAborted();
  const started = Date.now();
  let phase = "加载构建上下文",
    errorCode,
    timedOut = false,
    stopped = false;
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  report(`镜像构建开始（超时 ${timeoutMs / 1000} 秒）`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let killTimer;
    const kill = sig => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Already exited. */
      }
    };
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    const pulse = setInterval(() => report(`${phase}，已等待 ${elapsed()} 秒`), 10000);
    const consume = stream => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        pending += chunk;
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop().slice(-4096);
        for (const line of lines) {
          const next = /RUN\b.*\bnpm ci\b/.test(line)
            ? "安装 npm 依赖（容器内网络）"
            : /RUN npm run build/.test(line)
              ? "编译镜像内 TypeScript"
              : /load metadata|resolve .*sha256/.test(line)
                ? "解析基础镜像"
                : /exporting/.test(line)
                  ? "导出镜像"
                  : undefined;
          if (next && next !== phase) {
            phase = next;
            report(`${phase}（${elapsed()} 秒）`);
          }
          const code = line.match(/npm (?:ERR!|error) code (E[A-Z0-9_]+)/)?.[1];
          if (code) errorCode = code;
        }
      });
    };
    consume(child.stdout);
    consume(child.stderr);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const finish = error => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(pulse);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", () => finish(Error("无法启动 Docker 构建，请检查 Docker Desktop")));
    child.once("close", code => {
      if (timedOut)
        finish(Error(`构建超时：${phase}，${elapsed()} 秒；请检查 Docker 内 npm/镜像源网络`));
      else if (stopped) finish(Error("镜像准备已取消"));
      else if (code !== 0)
        finish(
          Error(
            `镜像构建失败：${phase}${errorCode ? " / " + errorCode : ""}；详情见 Docker Desktop Builds`
          )
        );
      else finish();
    });
  });
  report(`镜像构建完成（${elapsed()} 秒）`);
}
