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
/** Conversation files of one Run, prepared for the sandbox: each loaded file is downloaded within
 * the per-file and per-Run byte limits, given a safe unique name, and listed with every other file
 * in a manifest (original name, path, type, size, relation, load state). A file that cannot be
 * downloaded is listed as not loaded; it never fails the Run. */
import {
  INPUT_FILE_MAX_BYTES,
  INPUT_MANIFEST,
  INPUT_MANIFEST_MAX_BYTES,
  INPUT_NAME_MAX_LENGTH,
  INPUT_TOTAL_MAX_BYTES,
  isSafeInputName
} from "../common/input-files.js";
import type { LeaseFile } from "../spi/control-plane.js";
import type { SandboxInputFile } from "../spi/sandbox.js";
import { DownloadError, downloadFile } from "./file-download.js";

/** One manifest entry, as the model reads it from `inputs/manifest.json`. */
export interface InputManifestEntry {
  /** Original file name. */
  readonly name: string;
  /** File name inside the inputs directory; null when the file was not loaded. */
  readonly path: string | null;
  readonly content_type: string | null;
  readonly size: number | null;
  readonly relation: "input" | "output";
  readonly loaded: boolean;
}

export interface StagedInputs {
  /** The downloaded files, then the manifest. */
  readonly files: readonly SandboxInputFile[];
  readonly loaded: number;
  readonly unloaded: number;
}

export interface StageOptions {
  /** Aborting it (cancellation, shutdown) rejects the staging. */
  readonly signal: AbortSignal;
  readonly send?: typeof fetch;
  /** Per file; default 30 seconds. */
  readonly fileTimeoutMs?: number;
  /** All downloads together; files still pending afterwards are not loaded. Default 60 seconds. */
  readonly totalTimeoutMs?: number;
  /** Parallel downloads; default 4. */
  readonly concurrency?: number;
  readonly now?: () => number;
  /** A loaded file that was skipped: its ID and a fixed code (never the name or URL). */
  readonly onSkip?: (fileId: string, code: string) => void;
}

/** Margin before a signed URL's expiry below which a download is not started. */
const EXPIRY_MARGIN_MS = 1_000;
const MAX_SUFFIX = 1_000;

/** A safe, unique (case-insensitive, the manifest's name reserved) file name for `original`:
 * the last path component, characters outside [A-Za-z0-9._-] replaced, the extension kept, `-2`,
 * `-3`... appended on collision. Records the result in `taken` (lower case). */
export function safeInputName(original: string, taken: Set<string>): string {
  const leaf = original.normalize("NFKC").split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  const suffix = dot > 0 ? leaf.slice(dot + 1) : "";
  const ext = /^[A-Za-z0-9]{1,10}$/.test(suffix) ? `.${suffix}` : "";
  const stem = (ext ? leaf.slice(0, dot) : leaf)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "");
  // Room for a "-NNN" suffix within the length limit.
  const base =
    stem.slice(0, INPUT_NAME_MAX_LENGTH - ext.length - 4).replace(/[^A-Za-z0-9]+$/, "") || "file";
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
    const key = candidate.toLowerCase();
    if (key !== INPUT_MANIFEST && !taken.has(key) && isSafeInputName(candidate)) {
      taken.add(key);
      return candidate;
    }
  }
  throw new Error("INPUT_NAME_EXHAUSTED");
}

/** The manifest file's content (pretty JSON); throws when it exceeds its byte limit. */
export function inputManifest(entries: readonly InputManifestEntry[]): Buffer {
  const content = Buffer.from(`${JSON.stringify(entries, null, 2)}\n`);
  if (content.length > INPUT_MANIFEST_MAX_BYTES) throw new Error("INPUT_MANIFEST_LIMIT");
  return content;
}

/** Download the loaded files (newest first take the byte budget first), then name them and build
 * the manifest. Rejects only when `options.signal` aborts. */
export async function stageInputFiles(
  files: readonly LeaseFile[],
  options: StageOptions
): Promise<StagedInputs> {
  const now = options.now ?? Date.now;
  const fileTimeoutMs = options.fileTimeoutMs ?? 30_000;
  const deadline = AbortSignal.timeout(options.totalTimeoutMs ?? 60_000);
  const signal = AbortSignal.any([options.signal, deadline]);
  const skip = (file: LeaseFile, code: string) => {
    try {
      options.onSkip?.(file.file_id, code);
    } catch {
      /* Diagnostics never affect staging. */
    }
  };
  const contents: (Buffer | undefined)[] = files.map(() => undefined);
  let budget = INPUT_TOTAL_MAX_BYTES;
  let next = 0;
  const work = async () => {
    for (let index = next++; index < files.length; index = next++) {
      const file = files[index]!;
      if (!file.loaded || !file.url) continue;
      if (signal.aborted) {
        skip(file, "DOWNLOAD_TIMEOUT");
        continue;
      }
      if ((file.expires_at ?? 0) <= now() + EXPIRY_MARGIN_MS) {
        skip(file, "URL_EXPIRED");
        continue;
      }
      const limit = Math.min(INPUT_FILE_MAX_BYTES, budget);
      if ((file.size ?? 0) > limit || limit <= 0) {
        skip(file, "INPUT_BUDGET_EXCEEDED");
        continue;
      }
      // Reserve the declared size (or the most it may take) before the download starts, so
      // parallel downloads together stay within the Run's budget.
      const reserved = file.size ?? limit;
      budget -= reserved;
      try {
        const data = await downloadFile(
          file.url,
          {
            maxBytes: reserved,
            ...(file.size !== undefined ? { expectedSize: file.size } : {}),
            timeoutMs: fileTimeoutMs
          },
          signal,
          options.send
        );
        contents[index] = data;
        budget += reserved - data.length;
      } catch (error) {
        budget += reserved;
        skip(file, error instanceof DownloadError ? error.code : "DOWNLOAD_FAILED");
      }
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  await Promise.all(Array.from({ length: lanes }, work));
  if (options.signal.aborted) throw new Error("ABORTED");

  const taken = new Set<string>();
  const staged: SandboxInputFile[] = [];
  const entries = files.map((file, index): InputManifestEntry => {
    const data = contents[index];
    const path = data ? safeInputName(file.name, taken) : null;
    if (data && path) staged.push(Object.freeze({ name: path, data }));
    return Object.freeze({
      name: file.name,
      path,
      content_type: file.content_type ?? null,
      size: data ? data.length : (file.size ?? null),
      relation: file.relation,
      loaded: !!data
    });
  });
  staged.push(Object.freeze({ name: INPUT_MANIFEST, data: inputManifest(entries) }));
  return Object.freeze({
    files: Object.freeze(staged),
    loaded: staged.length - 1,
    unloaded: files.length - (staged.length - 1)
  });
}
