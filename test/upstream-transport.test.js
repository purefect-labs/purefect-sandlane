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
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { keepAliveSend } from "../dist/gateway/model/upstream-transport.js";

async function tlsServer(t, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-upstream-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "key.pem");
  const certFile = path.join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyFile,
      "-out",
      certFile
    ],
    { stdio: "ignore" }
  );
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const sockets = new Set();
  const server = https.createServer({ key, cert }, handler);
  server.on("secureConnection", socket => sockets.add(socket));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { url: `https://localhost:${server.address().port}`, ca: cert, sockets, server };
}

test("keep-alive sender reuses one TLS connection across requests and streams the body", async t => {
  const seen = [];
  const { url, ca, sockets } = await tlsServer(t, (req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 20);
    });
  });
  const send = keepAliveSend({ ca });
  for (let i = 0; i < 3; i++) {
    const response = await send(`${url}/v1/responses`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ i })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
  }
  assert.equal(sockets.size, 1, "all requests must share one connection");
  assert.deepEqual(
    seen.map(s => s.body),
    ['{"i":0}', '{"i":1}', '{"i":2}']
  );
  assert.ok(seen.every(s => s.method === "POST" && s.auth === "Bearer k"));
});

test("a reused connection closed by the server is retried once on a fresh connection", async t => {
  let requests = 0;
  const { url, ca, sockets } = await tlsServer(t, (req, res) => {
    requests++;
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  const send = keepAliveSend({ ca });
  assert.equal(await (await send(`${url}/x`, { method: "GET" })).text(), "ok");
  // The server drops the idle connection without the client noticing yet.
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await (await send(`${url}/x`, { method: "POST", body: "{}" })).text(), "ok");
  assert.equal(requests, 2, "the request is delivered exactly once");
});

test("a reused connection reset after the response began is never retried", async t => {
  let requests = 0;
  const raw = [];
  const { url, ca, server } = await tlsServer(t, (req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      if (requests === 1) return res.end("ok");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      // TCP reset mid-stream on the reused connection: the request was processed.
      setTimeout(() => raw.at(-1).resetAndDestroy(), 30);
    });
  });
  server.on("connection", socket => raw.push(socket));
  const send = keepAliveSend({ ca });
  assert.equal(await (await send(`${url}/x`, { method: "GET" })).text(), "ok");
  const response = await send(`${url}/x`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(raw.length, 1, "no fresh connection was opened");
  assert.equal(requests, 2, "the processed request is not sent again");
});

test("redirects and non-https targets are refused", async () => {
  const send = keepAliveSend();
  await assert.rejects(send("http://localhost:1/x", { method: "GET" }));
  await assert.rejects(send("https://localhost:1/x", { method: "GET", redirect: "follow" }));
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await pause(5);
  }
}

/** Records method, path, credential and connection of every request. */
async function recordingServer(t) {
  const seen = [];
  const server = await tlsServer(t, (req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      socket: req.socket
    });
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  return { ...server, seen };
}

test("warm-up opens a connection without sending anything; the first real request takes it over", async t => {
  const { url, ca, sockets, seen } = await recordingServer(t);
  const logs = [];
  const send = keepAliveSend({ ca }, { log: (code, fields) => logs.push({ code, ...fields }) });
  send.warm(`${url}/v1/responses`);
  // Issued while the warm-up handshake is still in flight: it takes that connection.
  const response = await send(`${url}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer k" },
    body: "{}"
  });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(
    seen.map(s => [s.method, s.url, s.auth]),
    [["POST", "/v1/responses", "Bearer k"]]
  );
  assert.equal(sockets.size, 1, "the real request must not open a second TLS connection");
  await until(() => logs.length === 1);
  assert.equal(logs[0].code, "UPSTREAM_PRECONNECTED");
  // Once pooled, a later Run's warm-up has nothing to do.
  await pause(20);
  send.warm(url);
  await pause(30);
  assert.equal(sockets.size, 1);
});

test("warm-up is skipped while an idle connection is pooled, and failures are only logged", async t => {
  const { url, ca, sockets } = await recordingServer(t);
  const logs = [];
  const send = keepAliveSend({ ca }, { log: (code, fields) => logs.push({ code, ...fields }) });
  assert.equal(await (await send(`${url}/x`, { method: "POST", body: "{}" })).text(), "ok");
  await pause(20);
  send.warm(url);
  await pause(50);
  assert.equal(sockets.size, 1);
  assert.equal(logs.length, 0);
  // Unreachable origin and malformed input: no throw, a debug code only.
  send.warm("https://127.0.0.1:1/");
  send.warm("not a url");
  await until(() => logs.length === 2);
  assert.deepEqual(
    logs.map(l => l.code),
    ["UPSTREAM_PRECONNECT_FAILED", "UPSTREAM_PRECONNECT_FAILED"]
  );
  assert.ok(logs.some(l => l.error === "ECONNREFUSED"));
});

test("an unused spare connection is replaced before it expires", async t => {
  const { url, ca, sockets, seen } = await recordingServer(t);
  const send = keepAliveSend({ ca }, { spareMs: 60, log: () => {} });
  send.warm(url);
  await until(() => sockets.size === 1);
  await pause(90);
  // The expired spare is not used: the request opens a fresh connection.
  assert.equal(await (await send(`${url}/x`, { method: "POST", body: "{}" })).text(), "ok");
  assert.equal(sockets.size, 2);
  assert.equal(seen.length, 1);
});

test("a recently used origin keeps a ready connection until the window ends", async t => {
  const { url, ca, sockets, seen } = await recordingServer(t);
  // Pooled connections idle out after 40ms, so readiness relies on preconnected spares.
  const send = keepAliveSend(
    { ca, timeout: 40 },
    { refreshMs: 30, windowMs: 200, spareMs: 100, log: () => {} }
  );
  assert.equal(await (await send(`${url}/x`, { method: "POST", body: "{}" })).text(), "ok");
  await until(() => sockets.size >= 3);
  assert.deepEqual(
    seen.map(s => s.method),
    ["POST"],
    "keeping ready sends no requests"
  );
  // Past the window without real requests, no more connections are opened.
  await pause(300);
  const settled = sockets.size;
  await pause(150);
  assert.equal(sockets.size, settled);
});
