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
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
);
const report = JSON.parse(output)[0];
const files = report?.files?.map(entry => entry.path);
if (!Array.isArray(files) || files.length < 1) throw new Error("Invalid npm pack report");

const roots = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.en.md",
  "README.md",
  "package.json"
]);
const prefixes = ["contract/", "dist/", "docs/"];
const unexpected = files.filter(
  file => !roots.has(file) && !prefixes.some(prefix => file.startsWith(prefix))
);
if (unexpected.length) throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);

for (const required of [
  "LICENSE",
  "CHANGELOG.md",
  "NOTICE",
  "README.en.md",
  "dist/runtime/runtime.js",
  "dist/runtime/runtime.d.ts",
  "dist/runtime/managed.js",
  "dist/runtime/managed.d.ts",
  "dist/spi/run-credentials.js",
  "dist/spi/run-credentials.d.ts",
  "dist/spi/status.js",
  "dist/spi/status.d.ts",
  "contract/ai-execution-v1.schema.json"
]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
}

console.log(`Validated ${files.length} package files`);

// Install the actual artifact outside the checkout. Dependencies are resolved by npm;
// the package under test must never resolve through the repository's source tree.
const consumer = mkdtempSync(path.join(os.tmpdir(), "sandlane-consumer-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer], {
      encoding: "utf8"
    })
  )[0];
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" })
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(consumer, packed.filename)
    ],
    { cwd: consumer, stdio: "pipe" }
  );
  // Reuse the installed compiler only; the tested package and its runtime dependencies are packed/installed above.
  symlinkSync(
    path.resolve("node_modules/@types"),
    path.join(consumer, "node_modules/@types"),
    "dir"
  );
  writeFileSync(
    path.join(consumer, "consumer.ts"),
    `
import { createRuntime, type RuntimeOptions } from '@purefect/sandlane/runtime';
import { createManagedRuntime, createDefaultModelUpstreams, type ManagedRuntimeOptions } from '@purefect/sandlane/runtime/managed';
import { RunCredentialRegistry } from '@purefect/sandlane/core/credentials';
import type { StatusObserver } from '@purefect/sandlane/spi/status';
import type { RunCredentialLookup } from '@purefect/sandlane/spi/run-credentials';
import type { ModelUpstreamFactory } from '@purefect/sandlane/spi/model-upstream';
import { McpToolProvider, combineToolProviders, type McpConfig } from '@purefect/sandlane/plugins/mcp';
const mcpConfig: McpConfig = {
  servers: [{ id: 'example', transport: { type: 'http', url: 'https://mcp.example/mcp' },
    tools: [{ alias: 'echo', remoteName: 'echo', description: 'Echo', readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }],
  bindings: []
};
const externalMcp = new McpToolProvider(mcpConfig);
if (combineToolProviders(externalMcp).tools.length !== 1) throw Error('MCP export failed');
await externalMcp.close();
const upstreams: ModelUpstreamFactory = {
  responses: () => ({ invoke: async () => ({ events: [], usage: { inputTokens: 0, outputTokens: 0 } }) }),
  messages: () => ({ invoke: async () => ({ events: [], usage: { inputTokens: 0, outputTokens: 0 } }) })
};
const customModel: NonNullable<ManagedRuntimeOptions['model']> = { upstreams };
if (customModel.upstreams !== upstreams) throw Error('extension failed');
const bundled: ModelUpstreamFactory = createDefaultModelUpstreams('bearer');
if (typeof bundled.messages !== 'function') throw Error('default upstream export failed');
const registry: RunCredentialLookup = new RunCredentialRegistry();
const observe: StatusObserver = () => {};
const options: RuntimeOptions = {
  controlPlane: {
    claim: async (_request, signal) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    readLease: () => undefined,
    sync: async () => { throw Error('unused'); }, complete: async () => { throw Error('unused'); }
  },
  sandbox: { capabilities: { isolation: 'container', sessionReuse: false, channels: ['stdio'] }, open: async () => { throw Error('unused'); } },
  credentials: new RunCredentialRegistry(), concurrency: 1,
  lane: { runtimeId: 'consumer', lanes: ['test'], enabledTools: ['echo'] }, observeLane: () => observe
};
const handle = await createRuntime(options); await handle.close();
const factory: (options: ManagedRuntimeOptions) => ReturnType<typeof createRuntime> = createManagedRuntime;
if (typeof factory !== 'function' || !registry) throw Error('consumer failed');
`
  );
  execFileSync(
    path.resolve("node_modules/.bin/tsc"),
    [
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts"
    ],
    { cwd: consumer, stdio: "inherit" }
  );
  execFileSync(process.execPath, ["consumer.js"], { cwd: consumer, stdio: "inherit" });
  console.log("Packed ESM/TypeScript runtime consumer passed");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
