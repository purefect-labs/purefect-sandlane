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
/** Input files for a session allocation ("put inputs"): the Broker request's wire format, its
 * validation, and the tar archive the Broker builds itself and extracts in the container. The
 * caller sends only names and bytes; every archive path is `inputs/<safe name>` built here, so no
 * caller-chosen path, link or mode ever reaches the container.
 *
 * Wire format (application/octet-stream): a 4-byte big-endian header length, the header JSON
 * `{ref, files: [{name, size}]}`, then the files' bytes back to back in header order. */
import {
  INPUT_DIRECTORY,
  INPUT_FILE_MAX_BYTES,
  INPUT_MANIFEST,
  INPUT_MANIFEST_MAX_BYTES,
  INPUT_MAX_FILES,
  INPUT_TOTAL_MAX_BYTES,
  isSafeInputName
} from "../../common/input-files.js";
import { BrokerError, exactKeys, object, parseRef, type AllocationRef } from "./contracts.js";

export const INPUTS_CONTENT_TYPE = "application/octet-stream";
const HEADER_MAX_BYTES = 64 * 1024;
/** Largest request body the Broker reads for one put. */
export const INPUTS_BODY_LIMIT =
  4 + HEADER_MAX_BYTES + INPUT_TOTAL_MAX_BYTES + INPUT_MANIFEST_MAX_BYTES;

export interface InputFile {
  readonly name: string;
  readonly data: Buffer;
}

export interface InputsRequest {
  readonly ref: AllocationRef;
  readonly files: readonly InputFile[];
}

function invalid(message: string): never {
  throw new BrokerError("INVALID_INPUTS", 400, message);
}

/** Validate names and sizes: safe unique names (case-insensitive), at most INPUT_MAX_FILES files
 * plus the manifest, per-file and total byte limits. */
export function checkInputFiles(files: readonly { name: unknown; size: unknown }[]): void {
  if (files.length < 1 || files.length > INPUT_MAX_FILES + 1) invalid("Invalid file count");
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!isSafeInputName(file.name)) invalid("Invalid file name");
    const key = file.name.toLowerCase();
    if (names.has(key)) invalid("Duplicate file name");
    names.add(key);
    const limit = key === INPUT_MANIFEST ? INPUT_MANIFEST_MAX_BYTES : INPUT_FILE_MAX_BYTES;
    if (!Number.isSafeInteger(file.size) || Number(file.size) < 0) invalid("Invalid file size");
    if (Number(file.size) > limit) throw new BrokerError("INPUTS_LIMIT", 413, "File too large");
    if (key !== INPUT_MANIFEST) total += Number(file.size);
  }
  if (total > INPUT_TOTAL_MAX_BYTES) throw new BrokerError("INPUTS_LIMIT", 413, "Files too large");
}

/** Client side: the request body for `files` of `ref`. */
export function encodeInputs(
  ref: AllocationRef,
  files: readonly { name: string; data: Uint8Array }[]
): Buffer {
  checkInputFiles(files.map(file => ({ name: file.name, size: file.data.byteLength })));
  const header = Buffer.from(
    JSON.stringify({
      ref,
      files: files.map(file => ({ name: file.name, size: file.data.byteLength }))
    })
  );
  if (header.length > HEADER_MAX_BYTES) invalid("Header too large");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, ...files.map(file => Buffer.from(file.data))]);
}

/** Broker side: parse a complete request body. The body must hold exactly the declared bytes. */
export function decodeInputs(body: Buffer): InputsRequest {
  if (body.length < 4) invalid("Truncated request");
  const headerLength = body.readUInt32BE(0);
  if (headerLength < 2 || headerLength > HEADER_MAX_BYTES || 4 + headerLength > body.length)
    invalid("Invalid header length");
  let header: Record<string, unknown>;
  try {
    header = object(JSON.parse(body.subarray(4, 4 + headerLength).toString("utf8")) as unknown);
  } catch {
    invalid("Invalid header");
  }
  exactKeys(header, ["ref", "files"]);
  const ref = parseRef(header.ref);
  if (!Array.isArray(header.files)) invalid("Invalid files");
  const declared = header.files.map(item => {
    const file = object(item);
    exactKeys(file, ["name", "size"]);
    return { name: file.name, size: file.size };
  });
  checkInputFiles(declared);
  let offset = 4 + headerLength;
  const files = declared.map(file => {
    const data = body.subarray(offset, offset + Number(file.size));
    offset += Number(file.size);
    return Object.freeze({ name: String(file.name), data });
  });
  if (offset !== body.length) invalid("Body does not match the declared sizes");
  return Object.freeze({ ref, files: Object.freeze(files) });
}

const BLOCK = 512;

/** One ustar header: `name` is ASCII and at most 100 bytes (safe names guarantee it). */
function tarHeader(name: string, size: number, type: "0" | "5", mode: number, mtime: number) {
  const header = Buffer.alloc(BLOCK);
  const field = (value: string, offset: number, length: number) =>
    header.write(value, offset, length, "ascii");
  const octal = (value: number, offset: number, length: number) =>
    field(value.toString(8).padStart(length - 1, "0"), offset, length - 1);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(1000, 108, 8);
  octal(1000, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  // POSIX magic "ustar" NUL, version "00"; checksum as six octal digits, NUL, space.
  field("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8);
  return header;
}

/** The archive extracted under the workspace: the inputs directory (0700) and one regular file
 * (0600) per input. Only names validated by checkInputFiles reach this point. */
export function inputArchive(files: readonly InputFile[], now = Date.now()): Buffer[] {
  checkInputFiles(files.map(file => ({ name: file.name, size: file.data.length })));
  const mtime = Math.floor(now / 1000);
  const parts: Buffer[] = [tarHeader(`${INPUT_DIRECTORY}/`, 0, "5", 0o700, mtime)];
  for (const file of files) {
    parts.push(tarHeader(`${INPUT_DIRECTORY}/${file.name}`, file.data.length, "0", 0o600, mtime));
    parts.push(file.data);
    const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  // End of archive: two zero blocks.
  parts.push(Buffer.alloc(BLOCK * 2));
  return parts;
}
