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
/** Preflight reports redact credentials and flag required risks. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPreflight } from "../scripts/preflight-lib.js";

test("preflight detects configured MCP and never returns a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "purefect-preflight-"));
  const mcpScript = path.join(root, "server.js");
  await writeFile(mcpScript, "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n", "utf8");
  const runner = async (_command, args) => {
    if (args[0] === "--version") return { ok: true, stdout: "codex-cli 0.154.0\n", stderr: "", error: null };
    if (args[0] === "login") return { ok: true, stdout: "Logged in using API key sk-secret-value\n", stderr: "", error: null };
    return {
      ok: true,
      stdout: JSON.stringify([{ name: "purefect-client", enabled: true, transport: { type: "stdio", command: "node", args: [mcpScript] } }]),
      stderr: "",
      error: null
    };
  };

  try {
    const report = await runPreflight({ cwd: root, env: { ...process.env, DATA_DIR: ".data" }, runner });
    assert.equal(report.summary.failed, 0);
    assert.equal(report.checks.find((check) => check.id === "mcp.purefect-client").status, "pass");
    assert.equal(report.checks.find((check) => check.id === "mcp.tls").status, "warn");
    assert.equal(report.checks.find((check) => check.id === "codex.authentication").summary, "Authenticated with an API key");
    assert.doesNotMatch(JSON.stringify(report), /sk-secret-value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
