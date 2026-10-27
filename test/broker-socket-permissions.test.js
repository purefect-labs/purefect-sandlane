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
import { chmod, chown, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listenUnix } from "../dist/sandbox/docker/server.js";
import { requireSocketDirectory } from "../dist/sandbox/docker/socket-permissions.js";

test("preflight and listener share private/group directory rejection rules", async t => {
  const group = process.getgroups().find(id => id > 0);
  assert.ok(group);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pf-broker-preflight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chown(dir, process.getuid(), group);
  const socket = path.join(dir, "broker.sock");
  await chmod(dir, 0o700);
  await requireSocketDirectory(socket);
  await assert.rejects(requireSocketDirectory(socket, group));
  await chmod(dir, 0o710);
  await requireSocketDirectory(socket, group);
  await assert.rejects(requireSocketDirectory(socket));
  for (const mode of [0o770, 0o711]) {
    await chmod(dir, mode);
    await assert.rejects(requireSocketDirectory(socket, group));
  }
  await chmod(dir, 0o710);
  await symlink(dir, path.join(dir, "alias"));
  await assert.rejects(requireSocketDirectory(path.join(dir, "alias/broker.sock"), group));
  await assert.rejects(requireSocketDirectory(socket, 0));
  await assert.rejects(requireSocketDirectory("relative/broker.sock", group));
});

test("Broker permits an explicit control group without making its directory group writable", async t => {
  const group = process.getgroups().find(id => id > 0);
  assert.ok(group);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pf-broker-group-"));
  const server = http.createServer((req, res) => res.end("ready"));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await chown(dir, process.getuid(), group);
  await chmod(dir, 0o770);
  const socket = path.join(dir, "broker.sock");
  await assert.rejects(listenUnix(server, socket, group), /parent must/);
  assert.equal(server.listening, false);
  await chmod(dir, 0o710);
  await listenUnix(server, socket, group);
  const info = await lstat(socket);
  assert.equal(info.gid, group);
  assert.equal(info.mode & 0o777, 0o660);
  // Mode/ownership regression only; distinct-UID Docker denial must be verified on target Linux.
  const response = await new Promise((resolve, reject) => {
    http
      .get({ socketPath: socket, path: "/" }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
  assert.equal(response, 200);
});
