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
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DockerEngine } from "../dist/sandbox/docker/docker-engine.js";
import { DockerOutputDecoder } from "../dist/sandbox/docker/docker-output.js";

const id = "a".repeat(64);
function frame(stream, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
async function daemon(t, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-attach-"));
  const sockets = new Set();
  const server = http.createServer();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", handler);
  const socketPath = `${root}/docker.sock`;
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return new DockerEngine(socketPath);
}
function upgraded(socket, head = Buffer.alloc(0)) {
  socket.write(
    Buffer.concat([
      Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
      ),
      head
    ])
  );
}
async function textOutput(channel) {
  const chunks = [];
  for await (const chunk of channel.output) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("Docker decoder handles every byte boundary, interleaved stderr and split UTF-8", () => {
  const data = Buffer.concat([
    frame(1, "你好🙂"),
    frame(2, "private diagnostic"),
    frame(1, "done")
  ]);
  for (let split = 0; split <= data.length; split++) {
    const decoder = new DockerOutputDecoder();
    const output = [
      ...decoder.push(data.subarray(0, split)),
      ...decoder.push(data.subarray(split))
    ];
    decoder.finish();
    assert.equal(Buffer.concat(output).toString(), "你好🙂done");
  }
});

test("Docker decoder rejects malformed, oversized, truncated and noisy streams without exposing stderr", () => {
  for (const mutate of [
    b => (b[0] = 0),
    b => (b[1] = 1),
    b => b.writeUInt32BE(128 * 1024 + 1, 4)
  ]) {
    const data = frame(1, "x");
    mutate(data);
    assert.throws(() => [...new DockerOutputDecoder().push(data)], /Docker stream/);
  }
  for (const data of [frame(1, "x").subarray(0, 4), frame(1, "x").subarray(0, 8)]) {
    const decoder = new DockerOutputDecoder();
    [...decoder.push(data)];
    assert.throws(() => decoder.finish(), /Truncated/);
  }
  for (const stream of [1, 2]) {
    const decoder = new DockerOutputDecoder();
    const data = frame(stream, Buffer.alloc(128 * 1024));
    for (let i = 0; i < 32; i++) [...decoder.push(data)];
    assert.throws(() => [...decoder.push(data)], /limit/);
  }
  const decoder = new DockerOutputDecoder();
  const empty = frame(2, "");
  for (let i = 0; i < 65_536; i++) [...decoder.push(empty)];
  assert.throws(() => [...decoder.push(empty)], /limit/);
});

test("Docker attach upgrades exact ID, exchanges bytes and drains final output without exporting stderr", async t => {
  let seen;
  const engine = await daemon(t, (req, socket) => {
    seen = req.url;
    upgraded(socket, frame(2, "private"));
    socket.once("data", data => socket.end(frame(1, data)));
  });
  const channel = await engine.attach(id, Date.now() + 5000, new AbortController().signal);
  const result = textOutput(channel);
  await channel.write(Buffer.from("你好🙂"));
  assert.equal(await result, "你好🙂");
  assert.equal(
    seen,
    `/v1.45/containers/${id}/attach?stream=true&stdin=true&stdout=true&stderr=true&logs=false`
  );
  await assert.rejects(textOutput(channel), /already consumed/);
  await assert.rejects(channel.write(Buffer.from("late")), /closed/);
});

test("Docker attach refuses redirects and sanitized raw daemon failures", async t => {
  const engine = await daemon(t, (_req, socket) =>
    socket.end("HTTP/1.1 302 Found\r\nLocation: http://private-token/\r\nContent-Length: 0\r\n\r\n")
  );
  await assert.rejects(
    engine.attach(id, Date.now() + 5000, new AbortController().signal),
    /^Error: Docker attach upgrade required$/
  );
  await assert.rejects(
    engine.attach("name-or-path", Date.now() + 5000, new AbortController().signal),
    /Invalid/
  );
});

test("Docker attach aborts during handshake and after upgrade without claiming process exit", async t => {
  let arrived;
  const request = new Promise(resolve => {
    arrived = resolve;
  });
  const engine = await daemon(t, (_req, socket) => arrived(socket));
  const abort = new AbortController();
  const pending = engine.attach(id, Date.now() + 5000, abort.signal);
  const rejected = assert.rejects(pending, /^Error: Docker attach failed$/);
  await request;
  abort.abort();
  await rejected;
  const other = await daemon(t, (_req, socket) => upgraded(socket));
  const cancellation = new AbortController();
  const channel = await other.attach(id, Date.now() + 5000, cancellation.signal);
  const failure = assert.rejects(textOutput(channel), /^Error: Docker attach output failed$/);
  cancellation.abort();
  await failure;
  assert.equal(channel.stopEvidence, undefined);
});

test(
  "Docker attach bounds stdin, rejects overlapping writes and closes on local deadline",
  { timeout: 5000 },
  async t => {
    const engine = await daemon(t, (_req, socket) => {
      upgraded(socket);
      socket.pause();
    });
    const channel = await engine.attach(id, Date.now() + 200, new AbortController().signal);
    await assert.rejects(channel.write(Buffer.alloc(128 * 1024 + 1)), /limit/);
    const pending = channel.write(Buffer.alloc(128 * 1024));
    const outcome = pending.catch(() => {});
    await assert.rejects(channel.write(Buffer.from("overlap")), /limit/);
    await assert.rejects(textOutput(channel), /output failed/);
    await outcome;
    await assert.rejects(channel.write(Buffer.from("late")), /closed/);
  }
);

test("Docker attach fails on truncated stream and closes when the consumer abandons output", async t => {
  const broken = await daemon(t, (_req, socket) => {
    upgraded(socket);
    socket.end(frame(1, "payload").subarray(0, 9));
  });
  const channel = await broken.attach(id, Date.now() + 5000, new AbortController().signal);
  await assert.rejects(textOutput(channel), /output failed/);
  let disconnected;
  const closed = new Promise(resolve => {
    disconnected = resolve;
  });
  const engine = await daemon(t, (_req, socket) => {
    upgraded(socket, frame(1, "first"));
    socket.resume();
    socket.once("end", () => {
      socket.end();
      disconnected();
    });
  });
  const abandoned = await engine.attach(id, Date.now() + 5000, new AbortController().signal);
  for await (const chunk of abandoned.output) {
    assert.equal(chunk.toString(), "first");
    break;
  }
  await closed;
  await assert.rejects(abandoned.write(Buffer.from("late")), /closed/);
});
