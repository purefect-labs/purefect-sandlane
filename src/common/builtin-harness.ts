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

export const BUILTIN_HARNESS_IDS = Object.freeze([
  "codex",
  "claude-code",
  "qwen-code",
  "opencode"
] as const);

export type BuiltinHarnessId = (typeof BUILTIN_HARNESS_IDS)[number];
export type BuiltinHarnessWire = "responses" | "anthropic-messages";

export const CODEX_FILE_FUNCTIONS: readonly string[] = Object.freeze([
  "exec_command",
  "write_stdin",
  "shell",
  "shell_command",
  "view_image"
]);
export const CLAUDE_CODE_FILE_FUNCTIONS: readonly string[] = Object.freeze([
  "Read",
  "Bash",
  "Glob",
  "Grep"
]);
export const CLAUDE_CODE_WEB_FUNCTIONS: readonly string[] = Object.freeze(["WebSearch"]);

export function codexModelFunctions(toolServer: string, tools: readonly string[]): string[] {
  return tools.map(tool => `mcp__${toolServer}.${tool.replaceAll(".", "_")}`);
}

export function claudeCodeToolName(server: string, tool: string): string {
  const normalize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${normalize(server)}__${normalize(tool)}`;
}

export function claudeCodeModelFunctions(toolServer: string, tools: readonly string[]): string[] {
  return tools.map(tool => claudeCodeToolName(toolServer, tool));
}

export function qwenCodeModelFunctions(toolServer: string, tools: readonly string[]): string[] {
  return tools.map(tool => `mcp__${toolServer}__${tool.replaceAll(".", "_")}`);
}

export function openCodeModelFunctions(toolServer: string, tools: readonly string[]): string[] {
  return tools.map(tool => `${toolServer}_${tool}`.replaceAll(/[^A-Za-z0-9_-]/g, "_"));
}

export interface BuiltinHarnessMetadata {
  readonly wire: BuiltinHarnessWire;
  readonly functions: (server: string, tools: readonly string[]) => readonly string[];
  readonly fileFunctions: readonly string[];
  readonly webFunctions: readonly string[];
}

export const BUILTIN_HARNESS_METADATA: Readonly<Record<BuiltinHarnessId, BuiltinHarnessMetadata>> =
  Object.freeze({
    codex: Object.freeze({
      wire: "responses" as const,
      functions: codexModelFunctions,
      fileFunctions: CODEX_FILE_FUNCTIONS,
      webFunctions: Object.freeze([])
    }),
    "claude-code": Object.freeze({
      wire: "anthropic-messages" as const,
      functions: claudeCodeModelFunctions,
      fileFunctions: CLAUDE_CODE_FILE_FUNCTIONS,
      webFunctions: CLAUDE_CODE_WEB_FUNCTIONS
    }),
    "qwen-code": Object.freeze({
      wire: "responses" as const,
      functions: qwenCodeModelFunctions,
      fileFunctions: Object.freeze([]),
      webFunctions: Object.freeze([])
    }),
    opencode: Object.freeze({
      wire: "responses" as const,
      functions: openCodeModelFunctions,
      fileFunctions: Object.freeze([]),
      webFunctions: Object.freeze([])
    })
  });

export function isBuiltinHarness(value: string): value is BuiltinHarnessId {
  return Object.hasOwn(BUILTIN_HARNESS_METADATA, value);
}

export function builtinHarnessWires(): Readonly<Record<BuiltinHarnessId, BuiltinHarnessWire>> {
  return Object.freeze(
    Object.fromEntries(
      BUILTIN_HARNESS_IDS.map(id => [id, BUILTIN_HARNESS_METADATA[id].wire])
    ) as Record<BuiltinHarnessId, BuiltinHarnessWire>
  );
}

export function builtinFunctionInventory(
  server: string,
  tools: readonly string[],
  harnesses: readonly BuiltinHarnessId[] = BUILTIN_HARNESS_IDS
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries(
      harnesses.map(id => [
        id,
        Object.freeze([...BUILTIN_HARNESS_METADATA[id].functions(server, tools)])
      ])
    )
  );
}

export function builtinFileFunctionInventory(
  harnesses: readonly BuiltinHarnessId[] = BUILTIN_HARNESS_IDS
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries(
      harnesses.map(id => [id, Object.freeze([...BUILTIN_HARNESS_METADATA[id].fileFunctions])])
    )
  );
}

export function builtinWebFunctionInventory(
  harnesses: readonly BuiltinHarnessId[] = BUILTIN_HARNESS_IDS
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries(
      harnesses
        .filter(id => BUILTIN_HARNESS_METADATA[id].webFunctions.length)
        .map(id => [id, Object.freeze([...BUILTIN_HARNESS_METADATA[id].webFunctions])])
    )
  );
}
