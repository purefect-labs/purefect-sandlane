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
const HEADER_BYTES = 8;
const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_CHANNEL_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES = 65_536;

/** Incremental non-TTY Docker framing. Retains only a header; never buffers frame bodies. */
export class DockerOutputDecoder {
  private readonly header = Buffer.alloc(HEADER_BYTES);
  private headerBytes = 0;
  private remaining = 0;
  private stream = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private frames = 0;

  /** `maxChannelBytes` bounds each of stdout and stderr; raised only for a Broker-internal read
   * whose caller enforces its own, tighter cap (see SessionProcesses.read). */
  constructor(private readonly maxChannelBytes = MAX_CHANNEL_BYTES) {}

  *push(chunk: Buffer): Generator<Buffer> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const size = Math.min(HEADER_BYTES - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + size);
        this.headerBytes += size;
        offset += size;
        if (this.headerBytes < HEADER_BYTES) return;
        this.readHeader();
        if (this.remaining === 0) continue;
      }
      const size = Math.min(this.remaining, chunk.length - offset);
      const start = offset;
      offset += size;
      this.remaining -= size;
      // Do not decode UTF-8 here: a character may span frames or socket packets.
      if (this.stream === 1 && size > 0) yield chunk.subarray(start, offset);
    }
  }

  private readHeader(): void {
    // Docker non-TTY header: stream byte, three reserved zero bytes, uint32 BE body length.
    this.stream = this.header[0]!;
    const size = this.header.readUInt32BE(4);
    if (
      ![1, 2].includes(this.stream) ||
      this.header[1] !== 0 ||
      this.header[2] !== 0 ||
      this.header[3] !== 0
    ) {
      throw new Error("Invalid Docker stream header");
    }
    // Empty frames consume no byte budget, so they need a separate count limit.
    this.frames++;
    if (this.frames > MAX_FRAMES || size > MAX_FRAME_BYTES)
      throw new Error("Docker stream limit exceeded");
    if (this.stream === 1) this.stdoutBytes += size;
    else this.stderrBytes += size;
    if (this.stdoutBytes > this.maxChannelBytes || this.stderrBytes > this.maxChannelBytes) {
      throw new Error("Docker stream limit exceeded");
    }
    this.remaining = size;
    this.headerBytes = 0;
  }

  finish(): void {
    if (this.headerBytes !== 0 || this.remaining !== 0) throw new Error("Truncated Docker stream");
  }
}
