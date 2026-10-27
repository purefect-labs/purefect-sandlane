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
/** The Purefect tools, equivalent to the purefect-client MCP server in managed mode:
 * `purefect_call` calls any platform API as the Run owner (the platform decides what that user
 * may do), `list_api_docs` / `read_api_doc` read the API documentation shipped with
 * purefect-client. Descriptions follow purefect-client's own. */
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ToolCallFailed, ToolGatewayError, type ConfirmPrompt } from "../../spi/tool-provider.js";
import {
  ManagedPurefectAdapter,
  type ManagedPurefectClientFactory,
  type PurefectTool
} from "./purefect-adapter.js";

/** Tool provider server ID; also the MCP server name, so the model sees `mcp__purefect...`. */
export const PUREFECT_TOOL_SERVER = "purefect";
export const PUREFECT_CALL = "purefect_call";
export const LIST_API_DOCS = "list_api_docs";
export const READ_API_DOC = "read_api_doc";
export const READ_SKILL = "read_skill";
export const PUREFECT_TOOL_NAMES: readonly string[] = Object.freeze([
  PUREFECT_CALL,
  LIST_API_DOCS,
  READ_API_DOC,
  READ_SKILL
]);
/** The platform service read_skill calls with the Run owner's token; it serves only the skills
 * frozen in this Run's member settings. */
const RUN_SKILL_SERVICE = "sys.ai.run.skill";
/** Skill codes: the platform's code characters. */
const SKILL_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const PARAMS_LIMIT = 32_000;
/** Text returned by the documentation tools; well below the gateway's result limit. */
const DOC_OUTPUT_LIMIT = 48_000;
const DOC_FILE_LIMIT = 1024 * 1024;
const DOC_ENTRIES_LIMIT = 2_000;
const DOC_DEPTH_LIMIT = 8;
/** Domain::service, or a nested Domain member: Domain::member::service (a few levels deep). */
const API_CODE = /^[A-Za-z][A-Za-z0-9_.-]*(?:::[A-Za-z][A-Za-z0-9_-]*){0,4}$/;
const SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODULE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (reason?: string): never => {
  throw new ToolGatewayError("PUREFECT_TOOL_REJECTED", reason);
};
function keys(params: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) invalid();
  if (Object.keys(params).some(key => !allowed.includes(key))) invalid();
}
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Whether `code` matches one confirm pattern: the whole code, case-sensitive, `*` matching any
 * run of characters (e.g. `*::delete`, `pf.designer.meta.MetaManager::*`). */
/**
 * Whether a call needs the user's approval under one confirm pattern. A nested call
 * (Domain::member::service) reaches the same service as ChildDomain::service, and the Worker cannot
 * resolve which Domain that is, so it is matched conservatively: besides the code as called, the
 * pattern's service part is compared with the call's service name (`pf.x.MailManager::delete`
 * also covers `pf.basis.user.UserDomain::mail::delete`). Over-asking is preferred to a bypass.
 */
export function requiresConfirmation(code: string, pattern: string): boolean {
  if (matchesApiCode(code, pattern)) return true;
  const segments = code.split("::");
  if (segments.length < 3) return false;
  const service = segments[segments.length - 1]!;
  const at = pattern.lastIndexOf("::");
  return at >= 0 && matchesApiCode(service, pattern.slice(at + 2));
}

export function matchesApiCode(code: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return code === pattern;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (code.length < first.length + last.length || !code.startsWith(first) || !code.endsWith(last))
    return false;
  let at = first.length;
  const end = code.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = code.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** Parameter names whose values are never shown in a confirmation summary. */
const SENSITIVE_KEY =
  /pass(word|wd)?|pwd|secret|token|credential|auth|api[_-]?key|private[_-]?key|cookie|session|signature/i;
const SENSITIVE_VALUE = /^(?:eyJ[A-Za-z0-9_-]+\.|bearer\s|basic\s)/i;
const SUMMARY_FIELDS = 20;
const SUMMARY_VALUE = 48;
const SUMMARY_LIMIT = 1024;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
function previewValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY.test(key)) return "***";
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string")
    return SENSITIVE_VALUE.test(value) ? "***" : JSON.stringify(clip(value, SUMMARY_VALUE));
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isPlainObject(value)) return `{${Object.keys(value).length} fields}`;
  return "?";
}

/** What the user sees before approving a platform call: the API code, the site and each top-level
 * parameter with a clipped value (nested values as counts, credential-like values hidden). Never
 * the Run's token, which the tool arguments do not contain. */
export function callSummary(args: Readonly<Record<string, unknown>>): string {
  const lines = [`api_code: ${String(args.api_code)}`];
  if (typeof args.site === "string") lines.push(`site: ${args.site}`);
  const params = isPlainObject(args.params) ? Object.entries(args.params) : [];
  if (params.length) {
    const shown = params.slice(0, SUMMARY_FIELDS).map(([key, value]) => {
      const name = /^[A-Za-z0-9_.$-]{1,64}$/.test(key) ? key : JSON.stringify(clip(key, 32));
      return `${name}=${previewValue(key, value)}`;
    });
    if (params.length > SUMMARY_FIELDS) shown.push(`… (+${params.length - SUMMARY_FIELDS} more)`);
    lines.push(`params: ${shown.join(", ")}`);
  } else lines.push("params: {}");
  const text = lines.join("\n");
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;
}

const callDescription = [
  'Call any Purefect platform API. api_code format: "{domain}::{method}".',
  "Use list_api_docs then read_api_doc to discover APIs and their parameters.",
  "",
  "Reading metadata (what a Domain/model/page offers): prefer the compact MetaManager::get_meta_summary",
  "{type, code}; use MetaManager::get_meta (full, much larger) only for details the summary lacks.",
  "get_raw/get_raw_summary are design-time APIs for",
  "changing metadata; do not use them just to read. Before any MetaManager::replace or create,",
  "read apis/meta/replace.md (full-replace rules; violations cause data loss).",
  "Before the first MetaManager::create, plan namespace and catalog (apis/meta/namespace-and-catalog.md):",
  "follow the module's existing catalog (load_cat), split by audience into authorization packages",
  "(<module>.<user-facing> / .admin / .worker / .data), one feature = one sub-package + sub-catalog; never dump flat.",
  "",
  "Files/images: file and image fields store only pf-file:// refs (pf-platform-file:// for platform files), never URLs.",
  '  For an external URL call pf.basis.tools.file.FileStorage::upload {"source_url":"https://...","model_code":...,"field_code":...}',
  "  and write the returned file_ref (see apis/file-storage/server-upload.md).",
  "",
  "Managed identity is fixed by the platform: calls run as the current user with that user's permissions. Identity/profile overrides are not supported; site selects another site of the same tenant.",
  "",
  "Auth is handled automatically - do not call sys.auth.* manually."
].join("\n");

const listDescription = [
  "List available API documentation files in the apis/ directory.",
  "Returns a tree of markdown files. Use this to discover which APIs exist,",
  "then use read_api_doc for the relevant file.",
  "",
  "The apis/ directory is organized by module (e.g. auth/, meta/, datastore/).",
  "Each .md file documents one API or a group of related APIs."
].join("\n");

const readDescription = [
  "Read one documentation file returned by list_api_docs.",
  "Works when the MCP server and Agent do not share a filesystem.",
  "Use start_line and line_count to keep context small."
].join("\n");

function purefectCall(): PurefectTool {
  return {
    alias: PUREFECT_CALL,
    version: 1,
    readOnly: false,
    description: callDescription,
    inputSchema: {
      type: "object",
      properties: {
        api_code: {
          type: "string",
          maxLength: 256,
          description:
            'API code, e.g. "pf.designer.meta.MetaManager::get_meta_summary" or "blis.md.product::search"'
        },
        params: {
          type: "object",
          description: "Request body as a JSON object. Omit or pass {} if no parameters needed."
        },
        site: {
          type: "string",
          maxLength: 128,
          description:
            "Override the site for this call (the platform checks it). Omit to use the user's current site."
        }
      },
      required: ["api_code"],
      additionalProperties: false
    },
    validateParams(params) {
      if (
        !isPlainObject(params) ||
        Object.keys(params).some(key => !["api_code", "params", "site"].includes(key))
      )
        invalid("arguments are api_code, params (object) and optional site");
      const { api_code: code, params: body, site } = params;
      if (typeof code !== "string" || code.length > 256 || !API_CODE.test(code))
        invalid("api_code must look like Domain::service or Domain::member::service");
      if (body !== undefined && !isPlainObject(body)) invalid("params must be a JSON object");
      if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > PARAMS_LIMIT)
        invalid(`params must be at most ${PARAMS_LIMIT} bytes as JSON`);
      if (site !== undefined && (typeof site !== "string" || !SITE.test(site)))
        invalid("site must be a site code");
    },
    summarize: params => (typeof params.api_code === "string" ? { api_code: params.api_code } : {}),
    // Approval bridge: an API code that matches the Run's confirm_api_codes waits for the user.
    confirmation(params, patterns): ConfirmPrompt | undefined {
      const code = String(params.api_code);
      if (!patterns.some(pattern => requiresConfirmation(code, pattern))) return undefined;
      return { title: clip(code, 199), summary: callSummary(params) };
    },
    async call(params, client) {
      const site = typeof params.site === "string" ? params.site : undefined;
      return client(site).request(String(params.api_code), params.params ?? {});
    }
  };
}

function readSkill(): PurefectTool {
  return {
    alias: READ_SKILL,
    version: 1,
    readOnly: true,
    description: [
      "Read the full text of one of your skills listed under 可用技能 in the assistant profile.",
      "Skills are working methods (steps, rules, formats): read one when the task matches its",
      "description, then follow it. Only the skills listed for this run can be read."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          maxLength: 64,
          description: 'Skill code from the list, e.g. "quote_rules".'
        }
      },
      required: ["code"],
      additionalProperties: false
    },
    validateParams(params) {
      keys(params, ["code"]);
      if (typeof params.code !== "string" || !SKILL_CODE.test(params.code))
        invalid("code must be a skill code from the list");
    },
    summarize: params =>
      typeof params.code === "string" && SKILL_CODE.test(params.code) ? { skill: params.code } : {},
    async call(params, client) {
      return client().request(RUN_SKILL_SERVICE, { code: String(params.code) });
    }
  };
}

/** Read-only access to one documentation directory (purefect-client `apis/`): markdown files only,
 * no path outside the directory (symbolic links included), bounded file and output sizes. */
export class ApiDocs {
  private constructor(private readonly root: string) {}

  static async open(directory: string): Promise<ApiDocs> {
    if (!path.isAbsolute(directory)) throw new Error("API docs directory must be absolute");
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error("API docs directory unavailable");
    return new ApiDocs(root);
  }

  /** Tree of markdown files, optionally of one top-level module. */
  async list(module?: string): Promise<string> {
    const lines = ["Available API docs:\n"];
    let entries = 0;
    let bytes = 0;
    let truncated = false;
    const push = (line: string) => {
      if (truncated) return;
      const size = Buffer.byteLength(line) + 1;
      if (++entries > DOC_ENTRIES_LIMIT || bytes + size > DOC_OUTPUT_LIMIT - 200) {
        truncated = true;
        return;
      }
      bytes += size;
      lines.push(line);
    };
    const walk = async (dir: string, indent: string, depth: number): Promise<void> => {
      if (depth > DOC_DEPTH_LIMIT || truncated) return;
      const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
      for (const item of items) {
        if (item.name.startsWith(".")) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (module !== undefined && depth === 0 && item.name !== module) continue;
          push(`${indent}${item.name}/`);
          await walk(full, `${indent}  `, depth + 1);
        } else if (item.isFile() && item.name.endsWith(".md")) {
          if (module !== undefined && depth === 0) continue;
          const relative = path.relative(this.root, full).split(path.sep).join("/");
          const title = await headingOf(full);
          push(`${indent}${item.name}${title ? ` — ${title}` : ""}  ->  apis/${relative}`);
        }
      }
    };
    await walk(this.root, "", 0);
    if (truncated) lines.push("... (list truncated; pass module to narrow it)");
    lines.push('\nRead one document with read_api_doc({ path: "<module>/<file>.md" }).');
    return lines.join("\n");
  }

  /** Lines of one markdown file under the root. */
  async read(docPath: string, startLine = 1, lineCount = 200): Promise<string> {
    const relative = docPath.replace(/^apis[\\/]/, "");
    if (!relative || CONTROL.test(relative) || path.isAbsolute(relative))
      throw new ToolCallFailed("DOC_PATH_REJECTED", true);
    let real: string;
    try {
      real = await realpath(path.resolve(this.root, relative));
    } catch {
      throw new ToolCallFailed("DOC_NOT_FOUND", true);
    }
    if (!real.startsWith(`${this.root}${path.sep}`) || path.extname(real).toLowerCase() !== ".md")
      throw new ToolCallFailed("DOC_PATH_REJECTED", true);
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ToolCallFailed("DOC_PATH_REJECTED", true);
      if (info.size > DOC_FILE_LIMIT) throw new ToolCallFailed("DOC_TOO_LARGE", true);
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.split(/\r?\n/);
    const start = startLine - 1;
    const wanted = lines.slice(start, start + lineCount);
    const selected: string[] = [];
    let bytes = 0;
    for (const line of wanted) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > DOC_OUTPUT_LIMIT - 200) break;
      bytes += size;
      selected.push(line);
    }
    const last = start + selected.length;
    const more =
      selected.length < wanted.length
        ? `\n[output limit reached; continue with start_line=${last + 1}]`
        : "";
    return `[${relative} lines ${startLine}-${Math.min(last, lines.length)} of ${lines.length}]\n${selected.join("\n")}${more}`;
  }
}

function listApiDocs(docs: ApiDocs): PurefectTool {
  return {
    alias: LIST_API_DOCS,
    version: 1,
    readOnly: true,
    description: listDescription,
    inputSchema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description:
            'Filter by module name (subdirectory), e.g. "meta", "datastore", "auth". Omit to list all modules.'
        }
      },
      additionalProperties: false
    },
    validateParams(params) {
      keys(params, ["module"]);
      if (
        params.module !== undefined &&
        (typeof params.module !== "string" || !MODULE.test(params.module))
      )
        invalid();
    },
    summarize: params => (typeof params.module === "string" ? { module: params.module } : {}),
    call: async params => docs.list(typeof params.module === "string" ? params.module : undefined)
  };
}

function readApiDoc(docs: ApiDocs): PurefectTool {
  return {
    alias: READ_API_DOC,
    version: 1,
    readOnly: true,
    description: readDescription,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Relative path such as "meta/domain-template-best-practices.md".'
        },
        start_line: { type: "integer", minimum: 1, description: "First line, default 1." },
        line_count: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Lines to return, default 200."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    validateParams(params) {
      keys(params, ["path", "start_line", "line_count"]);
      const { path: doc, start_line: start, line_count: count } = params;
      if (
        typeof doc !== "string" ||
        !doc ||
        doc.length > 512 ||
        CONTROL.test(doc) ||
        (start !== undefined &&
          (!Number.isSafeInteger(start) || Number(start) < 1 || Number(start) > 1_000_000)) ||
        (count !== undefined &&
          (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 500))
      )
        invalid();
    },
    summarize: params =>
      typeof params.path === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(params.path)
        ? { doc: params.path }
        : {},
    call: async params =>
      docs.read(
        String(params.path),
        params.start_line === undefined ? 1 : Number(params.start_line),
        params.line_count === undefined ? 200 : Number(params.line_count)
      )
  };
}

export interface PurefectDeploymentConfig {
  gateway: string;
  targetRef: string;
  targetVersion: number;
  /** purefect-client's `apis/` directory (see apiDocsDirectory). */
  docs: ApiDocs;
}

/** Instantiates the adapter with every Purefect tool. The public inventory omits endpoint/tenant
 * routing and credentials. It is NOT a tenant publication or an execution grant. */
export function installPurefectTools(
  config: PurefectDeploymentConfig,
  factory: ManagedPurefectClientFactory
) {
  const tools = [purefectCall(), listApiDocs(config.docs), readApiDoc(config.docs), readSkill()];
  const adapter = new ManagedPurefectAdapter(config.gateway, tools, factory, {
    serverId: PUREFECT_TOOL_SERVER,
    targetRef: config.targetRef,
    targetVersion: config.targetVersion
  });
  const target = Object.freeze({
    target_ref: config.targetRef,
    target_version: config.targetVersion,
    tools: Object.freeze(adapter.tools.map(t => Object.freeze({ id: t.alias, version: t.version })))
  });
  return Object.freeze({ adapter, inventory: Object.freeze({ targets: Object.freeze([target]) }) });
}

/** purefect-client's documentation directory: `apis/` beside the client module's `lib/`. */
export function apiDocsDirectory(clientModule: string): string {
  return path.resolve(path.dirname(clientModule), "..", "apis");
}

/** The document's first "# " heading (bounded), so a listing says what each file covers. */
async function headingOf(file: string): Promise<string | undefined> {
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const line = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .split("\n")
        .find(l => l.startsWith("# "));
      return (
        line
          ?.slice(2)
          .replace(/[\p{Cc}]+/gu, " ")
          .trim()
          .slice(0, 100) || undefined
      );
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
