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

import {
  NATIVE_STATE_BYTES,
  nativeThread,
  type NativeThread
} from "../../common/native-session.js";

/** Fixed credential-free helper. Pin every parent with O_NOFOLLOW directory FDs: even a
 * concurrent rename/symlink cannot redirect the final open outside the approved directory.
 * The outer Broker still bounds stdout/time and checks the exec exit status. */
const HELPER = `
const fs = require('node:fs');
const parts = process.argv[1].split('/').filter(Boolean);
const write = process.argv[2] === 'write';
const max = ${NATIVE_STATE_BYTES};
const dirs = [];
let parent = '/';
try {
  for (const part of parts.slice(0, -1)) {
    const target = parent + '/' + part;
    if (write) { try { fs.mkdirSync(target, {mode: 0o700}); } catch(e) { if(e.code !== 'EEXIST') throw e; } }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    dirs.push(fd); parent = '/proc/self/fd/' + fd;
  }
  const target = parent + '/' + parts.at(-1);
  if (write) {
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if(size > max) process.exit(2);
      let offset = 0;
      while(offset < chunk.length) offset += fs.writeSync(fd, chunk, offset);
    });
    process.stdin.on('end', () => { fs.fsyncSync(fd); fs.closeSync(fd); for(const dir of dirs) fs.closeSync(dir); });
  } else {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if(!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > max) process.exit(2);
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while(read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length-read, read); if(!n) process.exit(2); read += n; }
    const after = fs.fstatSync(fd);
    if(after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) process.exit(2);
    fs.closeSync(fd); for(const dir of dirs) fs.closeSync(dir);
    process.stdout.write(bytes);
  }
} catch { process.exit(2); }
`;
export function nativeCommand(thread: NativeThread, write = false): string[] {
  return ["/usr/local/bin/node", "-e", HELPER, nativeThread(thread).path, write ? "write" : "read"];
}
