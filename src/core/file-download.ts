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
/** Bounded download of one signed file URL into memory. The URL is a bearer secret: no error,
 * message or cause produced here contains it (or anything the server returned). */

export interface DownloadLimits {
  /** Hard byte limit: a larger Content-Length or body aborts the download. */
  readonly maxBytes: number;
  /** Declared size; a body of another length is rejected. */
  readonly expectedSize?: number;
  readonly timeoutMs: number;
}

/** Fixed code only (`DOWNLOAD_*`); never the URL, the response or the underlying error. */
export class DownloadError extends Error {
  constructor(
    readonly code:
      | "DOWNLOAD_REJECTED"
      | "DOWNLOAD_FAILED"
      | "DOWNLOAD_TIMEOUT"
      | "DOWNLOAD_STATUS"
      | "DOWNLOAD_TOO_LARGE"
      | "DOWNLOAD_SIZE_MISMATCH"
  ) {
    super(code);
    this.name = "DownloadError";
  }
}

/** GET `url` (https only, no redirects) within `limits`. Aborts when `signal` aborts. */
export async function downloadFile(
  url: string,
  limits: DownloadLimits,
  signal: AbortSignal,
  send: typeof fetch = fetch
): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new DownloadError("DOWNLOAD_REJECTED");
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const abort = AbortSignal.any([signal, timeout]);
  const failure = () => new DownloadError(timeout.aborted ? "DOWNLOAD_TIMEOUT" : "DOWNLOAD_FAILED");
  let response: Response;
  try {
    // A signed URL answers directly; a redirect could only lead somewhere unexpected.
    response = await send(url, { method: "GET", redirect: "error", signal: abort });
  } catch {
    throw failure();
  }
  const body = response.body;
  const discard = () => void body?.cancel().catch(() => {});
  if (response.status !== 200 || !body) {
    discard();
    throw new DownloadError("DOWNLOAD_STATUS");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = /^[0-9]{1,15}$/.test(declared) ? Number(declared) : NaN;
    if (!Number.isSafeInteger(length) || length > limits.maxBytes) {
      discard();
      throw new DownloadError(
        Number.isSafeInteger(length) ? "DOWNLOAD_TOO_LARGE" : "DOWNLOAD_FAILED"
      );
    }
    if (limits.expectedSize !== undefined && length !== limits.expectedSize) {
      discard();
      throw new DownloadError("DOWNLOAD_SIZE_MISMATCH");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw failure();
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limits.maxBytes) throw new DownloadError("DOWNLOAD_TOO_LARGE");
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  if (limits.expectedSize !== undefined && total !== limits.expectedSize)
    throw new DownloadError("DOWNLOAD_SIZE_MISMATCH");
  return Buffer.concat(chunks, total);
}
