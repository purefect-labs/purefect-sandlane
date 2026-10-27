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
/** Generated files of one Run, on their way from the sandbox to the control plane: each file is
 * checked (type allow-list by extension and content, no macros, CSV formulas neutralized) and
 * reported one by one, refused files included, so the user sees every file the CLI produced. The
 * content came from a CLI that may have followed injected instructions: it is data to check,
 * never to interpret beyond these checks. A delivery problem never changes the Run's outcome. */
import {
  OUTPUT_DIRECTORY,
  OUTPUT_FILE_MAX_BYTES,
  isSafeOutputName,
  reportableOutputName,
  type OutputRejection
} from "../common/output-files.js";
import {
  ControlPlaneError,
  FAULT_LEASE_LOST,
  FAULT_OUTPUT_LIMIT,
  type OutputRequest,
  type OutputResult
} from "../spi/control-plane.js";
import type { SandboxOutputs } from "../spi/sandbox.js";
import { inflateRawSync } from "node:zlib";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type Kind = "pdf" | "ooxml" | "text" | "csv" | "json" | "image";

/** The allow-list (the platform's `ai_output` purpose): extension -> type and how to check it. */
const TYPES: Readonly<Record<string, { contentType: string; kind: Kind; part?: string }>> =
  Object.freeze({
    pdf: { contentType: "application/pdf", kind: "pdf" },
    docx: { contentType: DOCX, kind: "ooxml", part: "word/" },
    xlsx: { contentType: XLSX, kind: "ooxml", part: "xl/" },
    pptx: { contentType: PPTX, kind: "ooxml", part: "ppt/" },
    csv: { contentType: "text/csv", kind: "csv" },
    txt: { contentType: "text/plain", kind: "text" },
    md: { contentType: "text/markdown", kind: "text" },
    json: { contentType: "application/json", kind: "json" },
    png: { contentType: "image/png", kind: "image" },
    jpg: { contentType: "image/jpeg", kind: "image" },
    jpeg: { contentType: "image/jpeg", kind: "image" },
    gif: { contentType: "image/gif", kind: "image" },
    webp: { contentType: "image/webp", kind: "image" }
  });
/** Macro-enabled Office formats: refused as macros by name; content is checked for the rest. */
const MACRO_EXTENSIONS = new Set([
  "docm",
  "dotm",
  "xlsm",
  "xltm",
  "xlam",
  "xlsb",
  "pptm",
  "potm",
  "ppsm",
  "ppam"
]);

export type CheckedOutput =
  | { readonly contentType: string; readonly data: Buffer }
  | { readonly rejected: OutputRejection };

function startsWith(data: Buffer, ...bytes: (number | string)[]): boolean {
  return bytes.every((byte, index) =>
    typeof byte === "string" ? data[index] === byte.charCodeAt(0) : data[index] === byte
  );
}

/** Magic numbers, as the platform's FilePurposePolicy.matchesContent checks them. */
function imageMatches(contentType: string, data: Buffer): boolean {
  switch (contentType) {
    case "image/png":
      return startsWith(data, 0x89, "P", "N", "G", 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(data, 0xff, 0xd8, 0xff);
    case "image/gif":
      return startsWith(data, "G", "I", "F", "8");
    case "image/webp":
      return (
        data.length >= 12 &&
        startsWith(data, "R", "I", "F", "F") &&
        data.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

const MAX_ZIP_ENTRIES = 10_000;

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  /** Offset of the entry's local header. */
  readonly offset: number;
}

/** Names in a ZIP file's central directory, or undefined when it cannot be read (no end record,
 * ZIP64, out-of-range offsets, too many entries). The central directory is what Office reads, so
 * a part hidden from it is not opened either. */
export function zipEntryNames(data: Buffer): string[] | undefined {
  return zipEntries(data)?.map(entry => entry.name);
}

function zipEntries(data: Buffer): ZipEntry[] | undefined {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  if (data.length < 22) return undefined;
  // The end record is 22 bytes plus a comment of at most 65535.
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 65535); offset--)
    if (data.readUInt32LE(offset) === EOCD) {
      end = offset;
      break;
    }
  if (end < 0) return undefined;
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const start = data.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff || count > MAX_ZIP_ENTRIES || start + size > end)
    return undefined;
  const entries: ZipEntry[] = [];
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > start + size || data.readUInt32LE(offset) !== CENTRAL) return undefined;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > start + size) return undefined;
    entries.push({
      name: data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      flags: data.readUInt16LE(offset + 8),
      method: data.readUInt16LE(offset + 10),
      compressedSize: data.readUInt32LE(offset + 20),
      offset: data.readUInt32LE(offset + 42)
    });
    offset = next;
  }
  return entries;
}

/** Content of one entry, stored or deflated, at most `max` bytes; undefined when it cannot be
 * read (encrypted, other compression, out of range, corrupt or larger). */
function zipEntryData(data: Buffer, entry: ZipEntry, max: number): Buffer | undefined {
  const LOCAL = 0x04034b50;
  if (entry.flags & 1 || entry.offset + 30 > data.length) return undefined;
  if (data.readUInt32LE(entry.offset) !== LOCAL) return undefined;
  const start =
    entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
  if (start + entry.compressedSize > data.length) return undefined;
  const raw = data.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.length <= max ? raw : undefined;
  if (entry.method !== 8) return undefined;
  try {
    return inflateRawSync(raw, { maxOutputLength: max });
  } catch {
    return undefined;
  }
}

/** Parts that carry executable content in an Office package: VBA projects (and their
 * signatures), Excel 4.0 macro sheets and ActiveX controls. */
const MACRO_PART =
  /(^|[\\/])(vbaproject\.bin|vbaprojectsignature|vbadata\.xml)|(^|[\\/])(macrosheets|activex)[\\/]/i;

/** Content types of executable content, declared in `[Content_Types].xml`: VBA projects
 * (`application/vnd.ms-office.vbaProject`) and their data, macro-enabled main parts
 * (`...sheet.macroEnabled.main+xml`, ...), Excel 4.0 macro sheets and ActiveX controls. A part
 * can carry any name, so its declared type is checked as well as the names above. */
const MACRO_CONTENT_TYPE = /vbaproject|vbadata|macroenabled|macrosheet|activex/i;
/** `[Content_Types].xml` is a short list; anything larger is not a package Office writes. */
const CONTENT_TYPES_MAX_BYTES = 1 << 20;

/** The text of a `[Content_Types].xml` part (UTF-8 or UTF-16 with BOM) with numeric character
 * references resolved, so an escaped type name is matched too; undefined when it declares a
 * DTD (refused by OPC; entities could spell a type name otherwise). */
function contentTypesText(xml: Buffer): string | undefined {
  let text: string;
  if (xml[0] === 0xff && xml[1] === 0xfe) text = xml.subarray(2).toString("utf16le");
  else if (xml[0] === 0xfe && xml[1] === 0xff)
    text = Buffer.from(xml.subarray(2)).swap16().toString("utf16le");
  else text = xml.toString("utf8");
  if (/<!DOCTYPE/i.test(text)) return undefined;
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (reference, code: string) => {
    const point = code[0] === "x" || code[0] === "X" ? parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff ? String.fromCodePoint(point) : reference;
  });
}

function checkOoxml(data: Buffer, part: string): OutputRejection | undefined {
  if (!startsWith(data, "P", "K", 3, 4)) return "content_mismatch";
  const entries = zipEntries(data);
  if (!entries) return "content_mismatch";
  const names = entries.map(entry => entry.name);
  if (names.some(name => MACRO_PART.test(name))) return "macro";
  // The package of this kind: its content types and its main part's directory.
  if (!names.includes("[Content_Types].xml") || !names.some(name => name.startsWith(part)))
    return "content_mismatch";
  // Part names compare case-insensitively in OPC: every spelling of the content types part.
  for (const entry of entries) {
    if (entry.name.toLowerCase() !== "[content_types].xml") continue;
    const xml = zipEntryData(data, entry, CONTENT_TYPES_MAX_BYTES);
    const text = xml && contentTypesText(xml);
    if (text === undefined) return "content_mismatch";
    if (MACRO_CONTENT_TYPE.test(text)) return "macro";
  }
  return undefined;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function utf8Text(data: Buffer): string | undefined {
  try {
    const text = UTF8.decode(data);
    // NUL never occurs in text the user would open as text.
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;

/** Whether a cell value would be read as a formula by a spreadsheet: it starts with `=`, `+`,
 * `-`, `@`, tab or carriage return and is not a plain number (OWASP CSV injection). */
function formulaLike(value: string): boolean {
  return FORMULA_START.test(value) && !NUMBER.test(value);
}

/** A first line `sep=<char>` (optionally quoted): Excel takes the separator from it. */
const SEPARATOR_DIRECTIVE = /^"?sep=[^\r\n]*(\r\n|\n|\r|$)/i;

/** Neutralize spreadsheet formulas in delimited text (OWASP CSV injection): a cell that would
 * start a formula gets a leading `'`, inside its quotes when it is quoted; numbers such as `-5`
 * or `+3.2e1` stay as they are. Comma, semicolon and tab all count as separators, since a
 * spreadsheet picks one by locale or by sniffing the content: a cell is neutralized under each
 * reading (a `;` or tab inside a comma-separated cell is then treated as a cell start too). A
 * leading `sep=` directive line (or several) is removed, so the file cannot pick a separator.
 * Everything else (quoting, separators, line ends, a leading BOM) is kept byte for byte,
 * malformed quoting included. */
export function neutralizeCsv(text: string): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let source = bom ? text.slice(1) : text;
  // Repeatedly: the line after a removed directive would become the first line.
  while (SEPARATOR_DIRECTIVE.test(source)) source = source.replace(SEPARATOR_DIRECTIVE, "");
  let out = bom;
  let i = 0;
  const n = source.length;
  const separator = (char: string | undefined) =>
    char === "," || char === ";" || char === "\t" || char === "\n" || char === "\r";
  while (i < n) {
    if (source[i] === '"') {
      let j = i + 1;
      let value = "";
      while (j < n) {
        if (source[j] === '"') {
          if (source[j + 1] !== '"') break;
          value += '"';
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      out += `"${formulaLike(value) ? "'" : ""}${source.slice(i + 1, j)}`;
      i = j;
      if (i < n) {
        out += '"';
        i++;
      }
      // Anything between the closing quote and the next separator is kept as is.
      while (i < n && !separator(source[i])) out += source[i++];
    } else {
      let j = i;
      while (j < n && !separator(source[j])) j++;
      const value = source.slice(i, j);
      out += (formulaLike(value) ? "'" : "") + value;
      i = j;
    }
    if (i < n) {
      if (source[i] === "\r" && source[i + 1] === "\n") {
        out += "\r\n";
        i += 2;
      } else out += source[i++];
    }
  }
  return out;
}

/** Check one generated file and return what to deliver (type and possibly rewritten content) or
 * why it is refused. The type follows from the extension and must agree with the content. */
export function checkOutputFile(
  name: string,
  data: Uint8Array,
  maxBytes = OUTPUT_FILE_MAX_BYTES
): CheckedOutput {
  if (!isSafeOutputName(name)) return { rejected: "invalid_name" };
  const content = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (content.length > maxBytes) return { rejected: "too_large" };
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (MACRO_EXTENSIONS.has(extension)) return { rejected: "macro" };
  const type = Object.hasOwn(TYPES, extension) ? TYPES[extension] : undefined;
  if (!type) return { rejected: "type_not_allowed" };
  // Every allowed type has content; the control plane refuses empty files too.
  if (!content.length) return { rejected: "content_mismatch" };
  const accepted = (bytes: Buffer = content) => ({ contentType: type.contentType, data: bytes });
  switch (type.kind) {
    case "pdf":
      return startsWith(content, "%", "P", "D", "F", "-")
        ? accepted()
        : { rejected: "content_mismatch" };
    case "image":
      return imageMatches(type.contentType, content)
        ? accepted()
        : { rejected: "content_mismatch" };
    case "ooxml": {
      const problem = checkOoxml(content, type.part!);
      return problem ? { rejected: problem } : accepted();
    }
    case "json":
    case "text": {
      const text = utf8Text(content);
      if (text === undefined) return { rejected: "content_mismatch" };
      if (type.kind === "json")
        try {
          JSON.parse(text.replace(/^\uFEFF/, ""));
        } catch {
          return { rejected: "content_mismatch" };
        }
      return accepted();
    }
    case "csv": {
      const text = utf8Text(content);
      if (text === undefined) return { rejected: "content_mismatch" };
      const neutralized = neutralizeCsv(text);
      // Nothing left once a lone `sep=` line is removed.
      if (!neutralized.replace(/^\uFEFF/, "")) return { rejected: "content_mismatch" };
      const safe = Buffer.from(neutralized, "utf8");
      return safe.length > maxBytes ? { rejected: "too_large" } : accepted(safe);
    }
  }
}

/** What the lane passes to deliverOutputs. */
export interface DeliveryOptions {
  /** Send one report (the lane adds the lease proof). */
  readonly send: (
    report: Omit<OutputRequest, "job_id" | "generation" | "claim_token">,
    signal: AbortSignal
  ) => Promise<OutputResult>;
  /** No call starts after this instant (lease or Run deadline minus a margin). */
  readonly notAfter: () => number;
  /** Stop at once when this returns true (lease lost, shutdown). */
  readonly stopped?: () => boolean;
  readonly signal?: AbortSignal;
  /** Per call; default 60 seconds, always within notAfter. */
  readonly callTimeoutMs?: number;
  readonly now?: () => number;
  /** Diagnostics: fixed codes and counts only, never names, content or URLs. */
  readonly log?: (code: string, fields?: Readonly<Record<string, string | number>>) => void;
}

export interface Delivery {
  readonly delivered: number;
  readonly rejected: number;
  /** Reports that could not be made (call failed, out of time). */
  readonly unreported: number;
  /** Of those, uploads whose outcome is unknown (no answer): the file may have been stored. */
  readonly uncertain: number;
}

function faultOf(error: unknown): string | undefined {
  return error instanceof ControlPlaneError ? error.fault : undefined;
}

/** The control plane answered and did not take the request (an error envelope): nothing was
 * stored. Anything else (network, timeout, unreadable reply) leaves the outcome unknown. */
function refused(error: unknown): boolean {
  return (
    error instanceof ControlPlaneError &&
    (error.code === "CONTROL_PLANE_REJECTED" || error.code === "CONTROL_PLANE_FAULT")
  );
}

function code(error: unknown): string {
  if (error instanceof ControlPlaneError) return error.fault ?? error.code;
  return "UNEXPECTED";
}

/** Check and report every file: the accepted ones first (in the sandbox's order), then the
 * refused ones. An accepted file the control plane refuses is reported again as `upload_failed`
 * (`too_many` once its output limit is reached), so it is not silently lost. Uploads are never
 * retried, and one without an answer is not reported as failed either: a lost reply may already
 * have stored the file, which would then show as both generated and failed. Stops when the
 * lease is lost or time runs out; never throws. */
export async function deliverOutputs(
  outputs: SandboxOutputs,
  options: DeliveryOptions
): Promise<Delivery> {
  const now = options.now ?? Date.now;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const log = (code: string, fields?: Readonly<Record<string, string | number>>) => {
    try {
      options.log?.(code, fields);
    } catch {
      /* Diagnostics never affect delivery. */
    }
  };
  const checked: { name: string; result: CheckedOutput }[] = outputs.files.map(file => ({
    name: file.name,
    result: checkOutputFile(file.name, file.data)
  }));
  const pending: { name: string; result: CheckedOutput }[] = [
    ...checked.filter(item => "data" in item.result),
    ...checked.filter(item => "rejected" in item.result),
    ...outputs.rejected.map(item => ({
      name: item.name,
      result: { rejected: item.reason } as CheckedOutput
    }))
  ];
  let delivered = 0;
  let rejected = 0;
  let uncertain = 0;
  let limitReached = false;
  let lost = false;
  const call = async (
    report: Omit<OutputRequest, "job_id" | "generation" | "claim_token">
  ): Promise<"ok" | "failed" | "unknown" | "late"> => {
    const remaining = options.notAfter() - now();
    if (lost || options.stopped?.() || options.signal?.aborted || remaining <= 0) return "late";
    const signals = [AbortSignal.timeout(Math.max(1, Math.min(callTimeoutMs, remaining)))];
    if (options.signal) signals.push(options.signal);
    try {
      await options.send(report, AbortSignal.any(signals));
      return "ok";
    } catch (error) {
      if (faultOf(error) === FAULT_LEASE_LOST) lost = true;
      if (faultOf(error) === FAULT_OUTPUT_LIMIT) limitReached = true;
      log("OUTPUT_FILE_REPORT_FAILED", { error: code(error) });
      return refused(error) ? "failed" : "unknown";
    }
  };
  let index = 0;
  for (; index < pending.length; index++) {
    const { name, result } = pending[index]!;
    // Names from the sandbox are safe; a refused entry's name is display text made safe there.
    const shown = isSafeOutputName(name) ? name : reportableOutputName(name);
    const path = `${OUTPUT_DIRECTORY}/${shown}`;
    if ("data" in result && !limitReached) {
      const sent = await call({
        path,
        name: shown,
        content_type: result.contentType,
        content_base64: result.data.toString("base64")
      });
      if (sent === "late") break;
      if (sent === "ok") {
        delivered++;
        continue;
      }
      if (sent === "unknown") {
        uncertain++;
        continue;
      }
      if (lost) break;
    }
    const reason: OutputRejection =
      "rejected" in result ? result.rejected : limitReached ? "too_many" : "upload_failed";
    const sent = await call({ path, name: shown, rejected: reason });
    if (sent === "late" || lost) break;
    if (sent === "ok") rejected++;
  }
  const unreported = pending.length - delivered - rejected;
  if (index < pending.length) log("OUTPUT_FILES_INCOMPLETE", { remaining: pending.length - index });
  return { delivered, rejected, unreported, uncertain };
}
