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
/** Generated files of a session allocation ("get outputs"): the in-container commands, the
 * parsing of what they print, the selection under the limits and the reply's wire format.
 *
 * The container is not trusted: the CLI that wrote the files may have been steered by a prompt
 * injection. So nothing printed in the container is followed or extracted on the host. A `find`
 * lists the first-level entries of the outputs directory (type, size, raw name); only regular
 * files with safe names within the limits are then read with `tar`, by exact name and without
 * recursion, and the archive is parsed here entry by entry (links, directories, devices and any
 * name other than the requested ones never become files). Both reads have byte caps.
 *
 * Reply wire format (application/octet-stream): a 4-byte big-endian header length, the header
 * JSON `{files: [{name, size}], rejected: [{name, reason}]}`, then the files' bytes back to back
 * in header order. */
import {
  OUTPUT_DIRECTORY,
  OUTPUT_FILE_MAX_BYTES_CEILING,
  OUTPUT_MAX_FILES_CEILING,
  OUTPUT_MAX_REJECTED,
  OUTPUT_TOTAL_MAX_BYTES_CEILING,
  isSafeOutputName,
  reportableOutputName,
  type OutputLimits,
  type OutputRejection
} from "../../common/output-files.js";
import { BrokerError, exactKeys, object } from "./contracts.js";

export const OUTPUTS_CONTENT_TYPE = "application/octet-stream";
const HEADER_MAX_BYTES = 64 * 1024;
/** Largest reply body a client accepts. */
export const OUTPUTS_BODY_LIMIT = 4 + HEADER_MAX_BYTES + OUTPUT_TOTAL_MAX_BYTES_CEILING;
/** Cap of the listing's output; entries past it are not seen (and so not reported). */
export const LISTING_MAX_BYTES = 256 * 1024;
const WORKSPACE = "/workspace";
const DIRECTORY = `${WORKSPACE}/${OUTPUT_DIRECTORY}`;
/** Reasons the sandbox itself gives; the Worker adds the content-based ones. */
const SANDBOX_REJECTIONS: readonly OutputRejection[] = [
  "too_large",
  "too_many",
  "not_regular_file",
  "invalid_name"
];

/** GNU find: the outputs directory and its children (depth, type letter, size, path relative to
 * the workspace), NUL-terminated so any byte of a name survives. Matching by path instead of
 * starting at the directory keeps the exit status 0 when it does not exist, and `-P` (default)
 * never follows a symbolic link, the directory itself included. */
export const LIST_COMMAND: readonly string[] = Object.freeze([
  "find",
  WORKSPACE,
  "-mindepth",
  "1",
  "-maxdepth",
  "2",
  "(",
  "-path",
  DIRECTORY,
  "-o",
  "-path",
  `${DIRECTORY}/*`,
  ")",
  "-printf",
  "%d %y %s %P\\0"
]);

/** GNU tar of exactly `names` (validated safe names) in the outputs directory, without
 * recursion; pax format so long and non-ASCII names are carried intact. */
export function archiveCommand(names: readonly string[]): string[] {
  if (!names.length || !names.every(isSafeOutputName)) throw new Error("Invalid output names");
  return [
    "tar",
    "-c",
    "-f",
    "-",
    "--format=pax",
    "--no-recursion",
    "-C",
    DIRECTORY,
    "--",
    ...names
  ];
}

export interface ListedEntry {
  /** The name, or undefined when its bytes are not valid UTF-8. */
  readonly name: string | undefined;
  /** Shown when rejected. */
  readonly display: string;
  /** find's type letter: `f` regular file, `d`, `l`, `b`, `c`, `p`, `s`. */
  readonly type: string;
  readonly size: number;
}

export interface Listing {
  /** Whether the outputs directory exists as a real directory. */
  readonly directory: boolean;
  readonly entries: readonly ListedEntry[];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Buffer): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Parse the listing. A record cut off by the byte cap (the last one without its NUL) is
 * dropped; malformed records fail the whole read. */
export function parseListing(stdout: Buffer): Listing {
  let directory = false;
  const entries: ListedEntry[] = [];
  let start = 0;
  for (let end = stdout.indexOf(0, start); end >= 0; end = stdout.indexOf(0, start)) {
    const record = stdout.subarray(start, end);
    start = end + 1;
    const match = /^([12]) ([a-zA-Z]) (\d{1,15}) /.exec(record.subarray(0, 24).toString("latin1"));
    if (!match) throw new BrokerError("OUTPUTS_FAILED", 503, "Invalid output listing");
    const path = record.subarray(match[0].length);
    if (match[1] === "1") {
      if (path.toString("latin1") !== OUTPUT_DIRECTORY)
        throw new BrokerError("OUTPUTS_FAILED", 503, "Invalid output listing");
      directory = match[2] === "d";
      continue;
    }
    const prefix = Buffer.from(`${OUTPUT_DIRECTORY}/`);
    if (!path.subarray(0, prefix.length).equals(prefix))
      throw new BrokerError("OUTPUTS_FAILED", 503, "Invalid output listing");
    const raw = path.subarray(prefix.length);
    const name = utf8(raw);
    entries.push(
      Object.freeze({
        name,
        display: reportableOutputName(name ?? raw.toString("utf8")),
        type: match[2]!,
        size: Number(match[3])
      })
    );
  }
  // Children of a directory that is not one (a symlink cannot be descended by find -P anyway).
  return Object.freeze({ directory, entries: Object.freeze(directory ? entries : []) });
}

export interface Rejected {
  readonly name: string;
  readonly reason: OutputRejection;
}

export interface OutputPlan {
  /** Regular files to read, by name, with their listed sizes. */
  readonly selected: readonly { readonly name: string; readonly size: number }[];
  readonly rejected: readonly Rejected[];
}

function reject(rejected: Rejected[], name: string, reason: OutputRejection): void {
  if (rejected.length < OUTPUT_MAX_REJECTED) rejected.push(Object.freeze({ name, reason }));
}

/** Choose what to read: entries in name order; an unsafe name is `invalid_name`, anything but a
 * regular file `not_regular_file`, then the per-file, count and total limits apply in that order.
 * The order makes the choice deterministic when there are more files than allowed. */
export function planOutputs(listing: Listing, limits: OutputLimits): OutputPlan {
  const selected: { name: string; size: number }[] = [];
  const rejected: Rejected[] = [];
  let total = 0;
  const sorted = [...listing.entries].sort((a, b) =>
    a.display < b.display ? -1 : a.display > b.display ? 1 : 0
  );
  for (const entry of sorted) {
    if (!isSafeOutputName(entry.name)) reject(rejected, entry.display, "invalid_name");
    else if (entry.type !== "f") reject(rejected, entry.name, "not_regular_file");
    else if (entry.size > limits.fileMaxBytes) reject(rejected, entry.name, "too_large");
    else if (selected.length >= limits.maxFiles) reject(rejected, entry.name, "too_many");
    else if (total + entry.size > limits.totalMaxBytes) reject(rejected, entry.name, "too_large");
    else {
      selected.push({ name: entry.name, size: entry.size });
      total += entry.size;
    }
  }
  return Object.freeze({ selected: Object.freeze(selected), rejected: Object.freeze(rejected) });
}

const BLOCK = 512;
/** Allowance per entry for its header and pax extended header blocks. */
const ENTRY_OVERHEAD = 4 * BLOCK;
/** End-of-archive blocks plus GNU tar's padding to its 10 KiB record. */
const ARCHIVE_TRAILER = 20 * BLOCK;
const PAX_MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 64;

/** Cap of the archive's bytes for `plan`: the listed sizes in blocks plus fixed overhead. A file
 * grown since the listing makes the read exceed it (and fail) instead of buffering without
 * bound. */
export function archiveLimit(plan: OutputPlan): number {
  return plan.selected.reduce(
    (sum, file) => sum + Math.ceil(file.size / BLOCK) * BLOCK + ENTRY_OVERHEAD,
    ARCHIVE_TRAILER
  );
}

export interface ArchiveEntry {
  /** Full entry name, or undefined when not valid UTF-8. */
  readonly name: string | undefined;
  /** ustar type flag (`0` regular, `1` hard link, `2` symlink, `5` directory, ...). */
  readonly type: string;
  /** Content of a regular file; empty for any other type. */
  readonly data: Buffer;
}

function broken(): never {
  throw new BrokerError("OUTPUTS_FAILED", 503, "Invalid output archive");
}

function field(header: Buffer, offset: number, length: number): Buffer {
  const value = header.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return end >= 0 ? value.subarray(0, end) : value;
}

function octal(header: Buffer, offset: number, length: number): number {
  // Base-256 sizes (high bit set) only occur for 8 GiB and above: never valid here.
  const text = field(header, offset, length).toString("latin1").trim();
  if (!/^[0-7]{1,12}$/.test(text)) broken();
  return parseInt(text, 8);
}

/** pax extended header records (`<length> <key>=<value>\n`): path and size only. */
function paxRecords(data: Buffer): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {};
  for (let offset = 0; offset < data.length; ) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) broken();
    const length = Number(data.subarray(offset, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) broken();
    const record = data.subarray(offset, offset + length);
    if (record.length !== length || record[length - 1] !== 0x0a) broken();
    const body = record.subarray(space - offset + 1, length - 1);
    const equals = body.indexOf(0x3d);
    if (equals < 0) broken();
    const key = body.subarray(0, equals).toString("latin1");
    const value = body.subarray(equals + 1);
    if (key === "path") {
      const path = utf8(value);
      if (path === undefined) broken();
      result.path = path;
    } else if (key === "size") {
      const text = value.toString("latin1");
      if (!/^\d{1,15}$/.test(text)) broken();
      result.size = Number(text);
    }
    offset += length;
  }
  return result;
}

/** Parse a POSIX (ustar/pax) archive. Checksums and magic are verified; GNU or other extension
 * headers, truncation or too many entries fail the whole archive. */
export function parseArchive(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pending: { path?: string; size?: number } | undefined;
  for (let offset = 0; ; ) {
    if (offset + BLOCK > archive.length) broken();
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) return entries;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (octal(header, 148, 8) !== sum) broken();
    // POSIX magic "ustar" NUL (GNU format's "ustar  " is refused).
    if (header.subarray(257, 263).toString("latin1") !== "ustar\u0000") broken();
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const size =
      type === "x" || type === "g"
        ? octal(header, 124, 12)
        : (pending?.size ?? octal(header, 124, 12));
    const start = offset + BLOCK;
    if (start + size > archive.length) broken();
    const data = archive.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x" || type === "g") {
      if (size > PAX_MAX_BYTES) broken();
      // A global header applies to nothing this reader uses; an extended one to the next entry.
      if (type === "x") pending = paxRecords(data);
      continue;
    }
    // GNU long names and other vendor headers are not produced in pax format.
    if (!/^[0-7]$/.test(type)) broken();
    if (entries.length >= MAX_ENTRIES) broken();
    const prefix = field(header, 345, 155);
    const base = field(header, 0, 100);
    const ustarName = utf8(prefix.length ? Buffer.concat([prefix, Buffer.from("/"), base]) : base);
    entries.push(
      Object.freeze({
        name: pending?.path ?? ustarName,
        type,
        data: type === "0" ? data : Buffer.alloc(0)
      })
    );
    pending = undefined;
  }
}

export interface CollectedOutputs {
  readonly files: readonly { readonly name: string; readonly data: Buffer }[];
  readonly rejected: readonly Rejected[];
}

/** Match the archive against the plan: each selected name must appear exactly once as a regular
 * file within the limits (else `not_regular_file` or `too_large`, e.g. replaced or grown after
 * the listing); any other entry (another name, a nested or traversing path) is `invalid_name`
 * and never returned. */
export function collectOutputs(
  plan: OutputPlan,
  entries: readonly ArchiveEntry[],
  limits: OutputLimits
): CollectedOutputs {
  const rejected = [...plan.rejected];
  const wanted = new Set(plan.selected.map(file => file.name));
  const found = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (entry.name !== undefined && wanted.has(entry.name) && !found.has(entry.name))
      found.set(entry.name, entry);
    else reject(rejected, reportableOutputName(entry.name ?? ""), "invalid_name");
  }
  const files: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (const { name } of plan.selected) {
    const entry = found.get(name);
    if (!entry || entry.type !== "0") reject(rejected, name, "not_regular_file");
    else if (
      entry.data.length > limits.fileMaxBytes ||
      total + entry.data.length > limits.totalMaxBytes
    )
      reject(rejected, name, "too_large");
    else {
      files.push(Object.freeze({ name, data: entry.data }));
      total += entry.data.length;
    }
  }
  return Object.freeze({ files: Object.freeze(files), rejected: Object.freeze(rejected) });
}

/** Broker side: the reply body (header, then the files' bytes). */
export function encodeOutputs(outputs: CollectedOutputs): Buffer[] {
  const header = Buffer.from(
    JSON.stringify({
      files: outputs.files.map(file => ({ name: file.name, size: file.data.length })),
      rejected: outputs.rejected.map(item => ({ name: item.name, reason: item.reason }))
    })
  );
  if (header.length > HEADER_MAX_BYTES) throw new Error("Output header too large");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return [length, header, ...outputs.files.map(file => file.data)];
}

function invalid(): never {
  throw new BrokerError("BROKER_PROTOCOL", 502, "Invalid outputs reply");
}

/** Client side: parse and check a complete reply body against the protocol ceilings. */
export function decodeOutputs(body: Buffer): CollectedOutputs {
  if (body.length < 4) invalid();
  const headerLength = body.readUInt32BE(0);
  if (headerLength < 2 || headerLength > HEADER_MAX_BYTES || 4 + headerLength > body.length)
    invalid();
  let header: Record<string, unknown>;
  try {
    header = object(JSON.parse(body.subarray(4, 4 + headerLength).toString("utf8")) as unknown);
    exactKeys(header, ["files", "rejected"]);
  } catch {
    invalid();
  }
  const { files, rejected } = header;
  if (
    !Array.isArray(files) ||
    files.length > OUTPUT_MAX_FILES_CEILING ||
    !Array.isArray(rejected) ||
    rejected.length > OUTPUT_MAX_REJECTED
  )
    invalid();
  let offset = 4 + headerLength;
  const names = new Set<string>();
  const decoded = files.map(item => {
    const file = object(item);
    if (
      Object.keys(file).length !== 2 ||
      !isSafeOutputName(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      Number(file.size) > OUTPUT_FILE_MAX_BYTES_CEILING
    )
      invalid();
    names.add(file.name);
    const data = body.subarray(offset, offset + Number(file.size));
    offset += Number(file.size);
    return Object.freeze({ name: file.name, data });
  });
  if (offset !== body.length || offset - 4 - headerLength > OUTPUT_TOTAL_MAX_BYTES_CEILING)
    invalid();
  const reasons = rejected.map(item => {
    const entry = object(item);
    if (
      Object.keys(entry).length !== 2 ||
      typeof entry.name !== "string" ||
      reportableOutputName(entry.name) !== entry.name ||
      !SANDBOX_REJECTIONS.includes(entry.reason as OutputRejection)
    )
      invalid();
    return Object.freeze({ name: entry.name, reason: entry.reason as OutputRejection });
  });
  return Object.freeze({ files: Object.freeze(decoded), rejected: Object.freeze(reasons) });
}
