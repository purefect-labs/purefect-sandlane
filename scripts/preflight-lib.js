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
/** Non-destructive pre-deployment checks producing a machine-readable report without credentials. */
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function result(id, status, summary, details = {}) {
  return { id, status, summary, details };
}

function sanitize(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/\bpfag_[A-Za-z0-9_-]+/g, "pfag_***")
    .trim();
}

function authenticationSummary(text) {
  const normalized = String(text).toLowerCase();
  if (normalized.includes("api key")) return "Authenticated with an API key";
  if (normalized.includes("chatgpt")) return "Authenticated with ChatGPT";
  if (normalized.includes("logged in") || normalized.includes("authenticated")) return "Codex authentication is configured";
  return "Codex authentication is configured (credential type not reported)";
}

export function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.once("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, error: null }));
  });
}

function parseJsonOutput(stdout) {
  const start = Math.min(...[stdout.indexOf("["), stdout.indexOf("{")].filter((index) => index >= 0));
  if (!Number.isFinite(start)) throw new Error("command did not return JSON");
  return JSON.parse(stdout.slice(start));
}

async function inspectMcpTls(mcp) {
  const args = mcp?.transport?.args || [];
  const script = args.find((value) => path.isAbsolute(value) && value.endsWith(".js"));
  if (!script) return null;
  try {
    const source = (await readFile(script, "utf8")).slice(0, 128_000);
    return {
      script,
      verificationDisabled: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(source)
    };
  } catch {
    return { script, verificationDisabled: null };
  }
}

export async function runPreflight({ cwd = process.cwd(), env = process.env, runner = run } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(result(
    "node.version",
    nodeMajor >= 20 ? "pass" : "fail",
    `Node.js ${process.versions.node}`,
    { required: ">=20" }
  ));

  const codexCommand = env.CODEX_BIN || "codex";
  const codexVersion = await runner(codexCommand, ["--version"], { cwd, env });
  checks.push(result(
    "codex.binary",
    codexVersion.ok ? "pass" : "fail",
    codexVersion.ok ? sanitize(codexVersion.stdout) : `Cannot execute ${codexCommand}`,
    { command: codexCommand, error: sanitize(codexVersion.error || codexVersion.stderr) || null }
  ));

  const login = codexVersion.ok
    ? await runner(codexCommand, ["login", "status"], { cwd, env })
    : { ok: false, stdout: "", stderr: "", error: "Codex binary unavailable" };
  checks.push(result(
    "codex.authentication",
    login.ok ? "pass" : "fail",
    login.ok ? authenticationSummary(`${login.stdout}\n${login.stderr}`) : "Codex is not authenticated",
    { credentialExposed: false }
  ));

  let mcps = [];
  let mcpError = null;
  if (codexVersion.ok) {
    const listed = await runner(codexCommand, ["mcp", "list", "--json"], { cwd, env });
    try {
      if (!listed.ok) throw new Error(listed.error || listed.stderr || "MCP list failed");
      mcps = parseJsonOutput(listed.stdout);
    } catch (error) {
      mcpError = sanitize(error.message);
    }
  }
  const purefectMcp = mcps.find((item) => item.name === "purefect-client");
  checks.push(result(
    "mcp.purefect-client",
    purefectMcp?.enabled ? "pass" : "fail",
    purefectMcp?.enabled ? "purefect-client is enabled" : "purefect-client is not enabled",
    purefectMcp ? {
      transport: purefectMcp.transport?.type || null,
      command: purefectMcp.transport?.command || null,
      args: purefectMcp.transport?.args || []
    } : { error: mcpError }
  ));

  const tls = await inspectMcpTls(purefectMcp);
  checks.push(result(
    "mcp.tls",
    tls?.verificationDisabled === true ? "warn" : tls?.verificationDisabled === false ? "pass" : "warn",
    tls?.verificationDisabled === true
      ? "Purefect MCP disables TLS certificate verification"
      : tls?.verificationDisabled === false
        ? "No global TLS bypass detected in the registered MCP script"
        : "Could not verify the Purefect MCP TLS policy",
    { script: tls?.script || null }
  ));

  const dataDir = path.resolve(cwd, env.DATA_DIR || ".data");
  try {
    await mkdir(path.join(dataDir, "runs"), { recursive: true });
    await mkdir(path.join(dataDir, "workspaces"), { recursive: true });
    await Promise.all([
      access(path.join(dataDir, "runs"), constants.R_OK | constants.W_OK),
      access(path.join(dataDir, "workspaces"), constants.R_OK | constants.W_OK)
    ]);
    checks.push(result("storage.data", "pass", "Worker data and workspace directories are writable", { dataDir }));
  } catch (error) {
    checks.push(result("storage.data", "fail", "Worker data directory is not writable", { dataDir, error: error.message }));
  }

  const defaultCodexHome = path.join(os.homedir(), ".codex");
  const codexHome = path.resolve(env.CODEX_HOME || defaultCodexHome);
  const personalHome = !env.CODEX_HOME || codexHome === defaultCodexHome;
  checks.push(result(
    "security.codex-home",
    personalHome ? "warn" : "pass",
    personalHome
      ? "Using the current OS user's personal Codex Home; development only"
      : "Using an explicitly configured Codex Home",
    { codexHome, explicitlyConfigured: Boolean(env.CODEX_HOME) }
  ));

  const approvalPolicy = env.CODEX_APPROVAL_POLICY || "on-request";
  const approvalsReviewer = env.CODEX_APPROVALS_REVIEWER || "auto_review";
  checks.push(result("policy.approvals", "pass", `${approvalPolicy} / ${approvalsReviewer}`, {
    approvalPolicy,
    approvalsReviewer
  }));
  checks.push(result(
    "events.redis",
    "pass",
    "Redis is intentionally not required by the MVP prototype",
    { enabled: false, authority: "worker-json-now; database-in-platform-mvp", delivery: "single-active-gateway" }
  ));

  const summary = {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass_with_warnings",
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    failed: checks.filter((check) => check.status === "fail").length
  };
  if (summary.warnings === 0 && summary.failed === 0) summary.status = "pass";
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), summary, checks };
}
