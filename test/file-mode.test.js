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
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_CODE_FILE_FUNCTIONS,
  claudeCodeLaunch,
  claudeCodeLauncher
} from "../dist/harness/claude-code/claude-code-launcher.js";
import {
  CODEX_FILE_FUNCTIONS,
  codexManagedConfig
} from "../dist/harness/codex/codex-managed-config.js";
import { CodexRunAdapter } from "../dist/harness/codex/codex-adapter.js";
import { LocalModelAuthority } from "../dist/gateway/model/local-authority.js";
import { RunCredentialRegistry } from "../dist/core/credentials.js";
import { parseMessagesRequest } from "../dist/gateway/model/messages-request.js";
import { parseResponsesRequest } from "../dist/gateway/model/responses-request.js";
import { FILE_REQUEST_BYTES } from "../dist/gateway/model/file-mode.js";
import { managedLaunch, parseRunAuthorization } from "../dist/sandbox/docker/managed-launch.js";
import { inputFilesInstructions } from "../dist/core/turn-input.js";

const config = (changes = {}) => ({
  modelAlias: "sandlane",
  modelBaseUrl: "https://model.internal:9443/v1",
  mcpUrl: "https://mcp.internal:9444/mcp",
  toolServer: "tools",
  modelCapability: "m".repeat(43),
  toolCapability: "t".repeat(43),
  enabledTools: ["purefect_call"],
  ...changes
});

test("Claude Code: file tools only in file mode, allowed under dontAsk; base args keep WebSearch only", () => {
  const value = (launch, flag) => launch.args[launch.args.indexOf(flag) + 1];
  const plain = claudeCodeLaunch(config());
  assert.equal(value(plain, "--tools"), "WebSearch");
  assert.equal(value(plain, "--allowedTools"), "WebSearch,mcp__tools__purefect_call");
  const files = claudeCodeLaunch(config({ fileTools: true }));
  assert.equal(value(files, "--tools"), "WebSearch,Read,Bash,Glob,Grep");
  assert.equal(
    value(files, "--allowedTools"),
    "WebSearch,Read,Bash,Glob,Grep,mcp__tools__purefect_call"
  );
  assert.equal(value(files, "--permission-mode"), "dontAsk");
  for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"])
    assert.ok(files.args.includes(flag), flag);
  assert.equal(files.args.filter(arg => arg === "--tools").length, 1);
  assert.deepEqual(CLAUDE_CODE_FILE_FUNCTIONS, ["Read", "Bash", "Glob", "Grep"]);
  // Without per-Run configuration (unmanaged launch) the CLI never has file tools.
  const base = claudeCodeLauncher.args;
  assert.equal(base[base.indexOf("--tools") + 1], "WebSearch");
  assert.throws(() => claudeCodeLaunch(config({ fileTools: "yes" })), /Claude Code configuration/);
});

test("Codex: shell and image viewing only in file mode; commands never inherit capabilities", () => {
  const plain = codexManagedConfig(config());
  assert.ok(plain.args.includes("features.shell_tool=false"));
  assert.ok(plain.args.includes("features.view_image=false"));
  assert.ok(!plain.args.some(arg => arg.startsWith("shell_environment_policy")));
  const files = codexManagedConfig(config({ fileTools: true }));
  for (const setting of [
    "features.shell_tool=true",
    "features.view_image=true",
    'shell_environment_policy.exclude=["SANDLANE_*"]',
    "features.goals=false",
    "features.multi_agent=false",
    "features.apps=false",
    "features.plugins=false"
  ])
    assert.ok(files.args.includes(setting), setting);
  assert.deepEqual(CODEX_FILE_FUNCTIONS, [
    "exec_command",
    "write_stdin",
    "shell",
    "shell_command",
    "view_image"
  ]);
  assert.ok(plain.args.includes("features.goals=false"));
  assert.throws(() => codexManagedConfig(config({ fileTools: 1 })));
});

/** Minimal app-server double: answers initialize, thread/start and one completed turn. */
class Transport {
  messages = [];
  async start(observer) {
    this.observer = observer;
  }
  async write(frame) {
    const m = JSON.parse(frame);
    this.messages.push(m);
    const reply = value => this.observer.stdout(Buffer.from(JSON.stringify(value) + "\n"));
    if (m.method === "initialize") reply({ id: m.id, result: {} });
    if (m.method === "thread/start") reply({ id: m.id, result: { thread: { id: "t" } } });
    if (m.method === "turn/start") {
      reply({ id: m.id, result: {} });
      reply({ method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  }
  async stop() {
    return { state: "exited", code: 0, signal: null };
  }
}

test("Codex Driver: file mode starts the thread in /workspace without a CLI sandbox or approvals", async () => {
  for (const fileTools of [undefined, true]) {
    const transport = new Transport();
    const adapter = new CodexRunAdapter({ workspace: "/workspace", transport });
    await adapter.execute({
      runId: "run-1",
      prompt: "hello",
      expiresAt: Date.now() + 10_000,
      ...(fileTools ? { fileTools } : {})
    });
    const start = transport.messages.find(m => m.method === "thread/start").params;
    assert.equal(start.cwd, "/workspace");
    assert.equal(start.approvalPolicy, "never");
    assert.equal(start.sandbox, fileTools ? "danger-full-access" : "read-only");
    await adapter.dispose();
  }
});

test("managed launch carries file mode in the hashed authorization; only `true` is accepted", () => {
  const expiresAt = Date.now() + 60_000;
  const auth = changes =>
    parseRunAuthorization(
      {
        modelAlias: "sandlane",
        toolServer: "tools",
        enabledTools: ["purefect_call"],
        model: { value: "m".repeat(43), expiresAt },
        tool: { value: "t".repeat(43), expiresAt },
        ...changes
      },
      expiresAt,
      Date.now()
    );
  assert.equal(auth({}).fileTools, undefined);
  assert.equal(auth({ fileTools: true }).fileTools, true);
  assert.throws(() => auth({ fileTools: false }), { code: "INVALID_RUN_AUTHORIZATION" });
  const policy = {
    modelBaseUrl: "https://model.internal:9443/v1",
    mcpUrl: "https://mcp.internal:9444/mcp"
  };
  const launch = managedLaunch(policy, auth({ fileTools: true }), "172.29.0.1", claudeCodeLauncher);
  assert.equal(launch.fileTools, true);
  assert.ok(launch.args.includes("WebSearch,Read,Bash,Glob,Grep"));
  assert.equal(managedLaunch(policy, auth({}), "172.29.0.1", claudeCodeLauncher).fileTools, false);
});

function grant(harness, fileTools) {
  return {
    jobId: "1",
    generation: 1,
    runId: "2",
    tenantId: "3",
    conversationId: "4",
    userId: "5",
    tenantAccessId: "5",
    attributes: {},
    runtime: { runtimeId: "rt", allocationId: `a-${harness}-${!!fileTools}` },
    harness,
    modelWire: harness === "codex" ? "responses" : "anthropic-messages",
    modelAlias: "sandlane",
    providerModel: "up",
    baseUri: "https://m.example/v1",
    enabledTools: [],
    webAccess: { mode: "off", domains: [] },
    ...(fileTools ? { fileTools: true } : {}),
    expiresAt: Date.now() + 60_000
  };
}
const secrets = () => ({
  modelKey: "k".repeat(32),
  agentToken: { value: "t", expiresAt: Date.now() + 60_000 },
  leaseUntil: Date.now() + 60_000
});

test("model gateway admits the file functions for file-mode Runs only, on both entries", async () => {
  const registry = new RunCredentialRegistry();
  const authority = new LocalModelAuthority(registry, {
    functions: {
      codex: ["mcp__tools.purefect_call"],
      "claude-code": ["mcp__tools__purefect_call"]
    },
    fileFunctions: {
      codex: [...CODEX_FILE_FUNCTIONS],
      "claude-code": [...CLAUDE_CODE_FILE_FUNCTIONS]
    },
    maxOutputTokens: 1000
  });
  const binding = async (harness, fileTools) =>
    authority.lookup(registry.register(grant(harness, fileTools), secrets()).capabilities().model);
  const claudePlain = await binding("claude-code", false);
  const claudeFiles = await binding("claude-code", true);
  assert.deepEqual(claudePlain.functions, ["mcp__tools__purefect_call"]);
  assert.equal(claudePlain.fileTools, undefined);
  assert.deepEqual(claudeFiles.functions, [
    "mcp__tools__purefect_call",
    "Read",
    "Bash",
    "Glob",
    "Grep"
  ]);
  assert.equal(claudeFiles.fileTools, true);
  const codexFiles = await binding("codex", true);
  assert.deepEqual(codexFiles.functions, [
    "mcp__tools.purefect_call",
    "exec_command",
    "write_stdin",
    "shell",
    "shell_command",
    "view_image"
  ]);

  // Messages: a Claude Code request with Bash and Read, and a replayed Bash call.
  const messages = {
    model: "sandlane",
    stream: true,
    max_tokens: 100,
    tools: ["Read", "Bash"].map(name => ({ name, input_schema: { type: "object" } })),
    messages: [
      { role: "user", content: "summarize the PDF" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "report.pdf" }]
      }
    ]
  };
  const headers = { betaQuery: false };
  assert.throws(() => parseMessagesRequest(messages, headers, claudePlain.functions, 1000));
  const parsed = parseMessagesRequest(
    messages,
    headers,
    claudeFiles.functions,
    1000,
    undefined,
    true
  );
  assert.deepEqual(
    parsed.body.tools.map(tool => tool.name),
    ["Read", "Bash"]
  );
  // An image the CLI read: larger than the default limit, allowed in file mode only.
  const image = {
    ...messages,
    messages: [
      ...messages.messages.slice(0, 2),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "A".repeat(2_000_000) }
              }
            ]
          }
        ]
      }
    ]
  };
  assert.throws(() => parseMessagesRequest(image, headers, claudeFiles.functions, 1000));
  parseMessagesRequest(image, headers, claudeFiles.functions, 1000, undefined, true);
  const huge = structuredClone(image);
  huge.messages[2].content[0].content[0].source.data = "A".repeat(FILE_REQUEST_BYTES);
  assert.throws(() =>
    parseMessagesRequest(huge, headers, claudeFiles.functions, 1000, undefined, true)
  );

  // Responses: Codex's command tool and view_image, the image returned as a tool output.
  const shell = { type: "function", name: "exec_command", parameters: { type: "object" } };
  const view = { type: "function", name: "view_image", parameters: { type: "object" } };
  const pixel = `data:image/png;base64,${"A".repeat(400_000)}`;
  const responses = {
    model: "sandlane",
    stream: true,
    tools: [shell, view],
    input: [
      { role: "user", content: [{ type: "input_text", text: "look" }] },
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c1",
        output: [{ type: "input_image", image_url: pixel }]
      }
    ]
  };
  assert.throws(() => parseResponsesRequest(responses, claudePlain.functions, 1000));
  assert.throws(() =>
    parseResponsesRequest(responses, codexFiles.functions, 1000, undefined, false)
  );
  const accepted = parseResponsesRequest(responses, codexFiles.functions, 1000, undefined, true);
  assert.deepEqual(
    accepted.tools.map(tool => tool.name),
    ["exec_command", "view_image"]
  );
  // Remote image URLs would make the provider fetch from the network: refused even in file mode.
  const remote = structuredClone(responses);
  remote.input[2].output[0].image_url = "https://evil.example/x.png";
  assert.throws(() => parseResponsesRequest(remote, codexFiles.functions, 1000, undefined, true));
  // A user message may carry the viewed image too (older CLI versions); never other roles.
  const inline = structuredClone(responses);
  inline.input[0].content.push({ type: "input_image", image_url: pixel, detail: "auto" });
  parseResponsesRequest(inline, codexFiles.functions, 1000, undefined, true);
  inline.input[0].role = "system";
  assert.throws(() => parseResponsesRequest(inline, codexFiles.functions, 1000, undefined, true));
});

test("Messages: only inline images and documents, in file mode; never a source the provider fetches", () => {
  const functions = ["mcp__tools__purefect_call", ...CLAUDE_CODE_FILE_FUNCTIONS];
  const headers = { betaQuery: false };
  const pdf = { type: "base64", media_type: "application/pdf", data: "JVBERi0=" };
  const png = { type: "base64", media_type: "image/png", data: "iVBORw0K" };
  /** A request whose last user turn carries `blocks`, at top level or inside a Read result. */
  const request = (blocks, inResult) => ({
    model: "sandlane",
    stream: true,
    max_tokens: 100,
    tools: ["Read", "Bash"].map(name => ({ name, input_schema: { type: "object" } })),
    messages: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a" } }]
      },
      {
        role: "user",
        content: inResult ? [{ type: "tool_result", tool_use_id: "tu_1", content: blocks }] : blocks
      }
    ]
  });
  const parse = (blocks, inResult, files = true) =>
    parseMessagesRequest(request(blocks, inResult), headers, functions, 1000, undefined, files);
  const INVALID = { message: "MODEL_MESSAGES_REQUEST_INVALID" };
  for (const inResult of [false, true]) {
    // What the CLI read, inline: accepted in file mode, refused otherwise.
    for (const block of [
      { type: "image", source: png },
      { type: "image", source: { ...png, media_type: "image/webp" } },
      { type: "document", source: pdf, title: "a.pdf" },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "hi" } }
    ]) {
      parse([block, { type: "text", text: "ok" }], inResult);
      assert.throws(() => parse([block], inResult, false), INVALID, JSON.stringify(block));
    }
    // Remote, provider-stored or unknown sources: refused even in file mode.
    for (const block of [
      { type: "image", source: { type: "url", url: "https://evil.example/x.png?d=secret" } },
      { type: "document", source: { type: "url", url: "https://evil.example/x.pdf" } },
      { type: "image", source: { type: "file", file_id: "file_123" } },
      { type: "document", source: { type: "file", file_id: "file_123" } },
      { type: "document", source: { type: "content", content: [{ type: "text", text: "x" }] } },
      { type: "image", source: { ...png, media_type: "image/svg+xml" } },
      { type: "document", source: { ...pdf, media_type: "text/html" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf" } },
      { type: "image", source: "https://evil.example/x.png" },
      {
        type: "search_result",
        source: "https://evil.example/r",
        title: "r",
        content: [{ type: "text", text: "x" }]
      },
      { type: "container_upload", file_id: "file_123" }
    ])
      assert.throws(() => parse([block], inResult), INVALID, JSON.stringify(block));
  }
  // Tool results hold content blocks, never another tool call or result.
  assert.throws(
    () => parse([{ type: "tool_use", id: "tu_2", name: "Bash", input: {} }], true),
    INVALID
  );
  assert.throws(
    () => parse([{ type: "tool_result", tool_use_id: "tu_1", content: "x" }], true),
    INVALID
  );
  assert.throws(() => parse({ type: "text", text: "x" }, true), INVALID);
  // The system prompt is text only.
  const system = request([{ type: "text", text: "ok" }], false);
  system.system = [{ type: "text", text: "You are", cache_control: { type: "ephemeral" } }];
  parseMessagesRequest(system, headers, functions, 1000, undefined, true);
  system.system.push({ type: "image", source: { type: "url", url: "https://evil.example/s" } });
  assert.throws(
    () => parseMessagesRequest(system, headers, functions, 1000, undefined, true),
    INVALID
  );
});

test("file-mode instructions: working directory, tools, untrusted content, no network", () => {
  const text = inputFilesInstructions(true);
  for (const part of [
    "/workspace",
    "/workspace/inputs",
    "manifest.json",
    "python3",
    "pypdf",
    "pdfplumber",
    "openpyxl",
    "pandas",
    "python-pptx",
    "python-docx",
    "matplotlib",
    "图片可以直接查看",
    "不可信",
    "不能联网",
    "/workspace/outputs/",
    "mkdir -p /workspace/outputs",
    "[文件名](outputs/文件名)",
    "最多 10 个"
  ])
    assert.ok(text.includes(part), part);
});
