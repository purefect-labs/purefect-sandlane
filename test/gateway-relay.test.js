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
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import test from "node:test";
import { GatewayRelay } from "../dist/network/gateway-relay.js";

const closed = socket => new Promise(resolve => socket.once("close", resolve));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function setup(t, limits = {}, onData = (data, socket) => socket.write(data)) {
  const sockets = new Set();
  const upstream = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", data => onData(data, socket));
  });
  const upstreamPort = await listen(upstream);
  const listenPort = await unusedPort();
  const route = { listenHost: "127.0.0.1", listenPort, upstreamHost: "127.0.0.1", upstreamPort };
  const relay = new GatewayRelay([route], limits);
  t.after(async () => {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  await relay.start();
  const connect = async () => {
    const socket = net.connect(listenPort, "127.0.0.1");
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await once(socket, "connect");
    return socket;
  };
  return { relay, connect, route, sockets };
}

test("relay forwards bytes to immutable fixed destination without interpreting CONNECT", async t => {
  const { connect, route } = await setup(t);
  route.upstreamPort = 1;
  const socket = await connect();
  const reply = once(socket, "data");
  const input = "CONNECT other-user.example:443 HTTP/1.1\r\n\r\n";
  socket.write(input);
  assert.equal((await reply)[0].toString(), input);
});

test("relay rejects names and invalid resource limits", () => {
  const route = {
    listenHost: "127.0.0.1",
    listenPort: 9999,
    upstreamHost: "127.0.0.1",
    upstreamPort: 443
  };
  for (const upstreamHost of ["localhost", "https://127.0.0.1", "example.com"]) {
    assert.throws(() => new GatewayRelay([{ ...route, upstreamHost }]), /INVALID/);
  }
  for (const limits of [
    { maxConnections: 0 },
    { perAddress: 65 },
    { lifetimeMs: 300001 },
    { bytesPerDirection: 16777217 },
    { connectMs: NaN }
  ]) {
    assert.throws(() => new GatewayRelay([route], limits), /INVALID/);
  }
});

test("TLS and Run credentials pass end-to-end without relay certificate or key", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pf-relay-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "key.pem"),
    certFile = path.join(root, "cert.pem");
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
      "/CN=gateway.test",
      "-addext",
      "subjectAltName=DNS:gateway.test",
      "-keyout",
      keyFile,
      "-out",
      certFile
    ],
    { stdio: "ignore" }
  );
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const received = [];
  const gateway = tls.createServer({ key, cert }, socket => {
    socket.on("error", () => {});
    socket.on("data", bytes => {
      received.push(bytes.toString());
      socket.end("authorized");
    });
  });
  const upstreamPort = await listen(gateway);
  const listenPort = await unusedPort();
  const relay = new GatewayRelay([
    { listenHost: "127.0.0.1", listenPort, upstreamHost: "127.0.0.1", upstreamPort }
  ]);
  t.after(async () => {
    await relay.close();
    await new Promise(resolve => gateway.close(resolve));
  });
  await relay.start();
  for (const capability of ["fixture-model-run-a", "fixture-model-run-b"]) {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: listenPort,
      servername: "gateway.test",
      ca: cert
    });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await once(socket, "secureConnect");
    assert.equal(socket.authorized, true);
    const reply = once(socket, "data");
    socket.write(capability);
    assert.equal((await reply)[0].toString(), "authorized");
    socket.destroy();
  }
  assert.deepEqual(received, ["fixture-model-run-a", "fixture-model-run-b"]);
});

test("relay bounds per-address connections and frees slots after disconnect", async t => {
  const { connect, sockets, relay } = await setup(t, { perAddress: 1 });
  const first = await connect();
  const echo = once(first, "data");
  first.write("ready");
  await echo;
  const denied = await connect();
  await closed(denied);
  const gone = closed([...sockets][0]);
  first.destroy();
  await gone;
  // Upstream's close and the relay's close are independent socket observations.
  // Wait for actual slot release before asserting reuse, not just peer-side EOF.
  const until = Date.now() + 1000;
  while (relay.connections.size && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(relay.connections.size, 0);
  const replacement = await connect();
  const response = once(replacement, "data");
  replacement.write("reused");
  assert.equal((await response)[0].toString(), "reused");
});

test("relay shuts down streams on byte overflow in either direction", async t => {
  for (const outbound of [true, false]) {
    const { connect } = await setup(t, { bytesPerDirection: 64 }, (data, socket) =>
      socket.write(outbound ? data : Buffer.alloc(65))
    );
    const socket = await connect();
    const stopped = closed(socket);
    socket.write(outbound ? Buffer.alloc(65) : "request");
    await stopped;
  }
});

test("relay preserves the final response under backpressure and client half-close", async t => {
  const payload = Buffer.alloc(1024 * 1024, 0x61);
  const { connect } = await setup(t, {}, (_data, socket) => socket.end(payload));
  const socket = await connect();
  const chunks = [];
  socket.on("data", chunk => chunks.push(chunk));
  socket.pause();
  const end = once(socket, "end");
  socket.end("request");
  await new Promise(resolve => setTimeout(resolve, 40));
  socket.resume();
  await end;
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test("relay expires idle streams and absolute lifetime despite traffic", async t => {
  for (const idle of [true, false]) {
    const { connect } = await setup(t, { idleMs: idle ? 40 : 100, connectMs: 50, lifetimeMs: 180 });
    const socket = await connect();
    const stopped = closed(socket);
    socket.resume();
    const interval = idle ? undefined : setInterval(() => socket.write("x"), 10);
    try {
      await stopped;
    } finally {
      clearInterval(interval);
    }
  }
});

test("relay shutdown closes live streams and does not permit restart", async t => {
  const { relay, connect } = await setup(t);
  const socket = await connect();
  const stopped = closed(socket);
  await relay.close();
  await stopped;
  await assert.rejects(relay.start(), /ALREADY_STARTED/);
});

test("second listener bind failure closes the first listener", async t => {
  const occupied = net.createServer();
  const occupiedPort = await listen(occupied);
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const available = await unusedPort();
  const relay = new GatewayRelay(
    [available, occupiedPort].map(listenPort => ({
      listenHost: "127.0.0.1",
      listenPort,
      upstreamHost: "127.0.0.1",
      upstreamPort: occupiedPort
    }))
  );
  await assert.rejects(relay.start(), /^Error: GATEWAY_RELAY_START_FAILED$/);
  const replacement = net.createServer();
  replacement.listen(available, "127.0.0.1");
  await once(replacement, "listening");
  await new Promise(resolve => replacement.close(resolve));
});
