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
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readSecret } from "../dist/common/env.js";
import { brokerSettings } from "../dist/sandbox/docker/config.js";
import { acquireStateLock } from "../dist/sandbox/docker/state-lock.js";

const env = { SANDLANE_BROKER_NODE_ID: "test-node",
  SANDLANE_BROKER_RUN_IMAGES: JSON.stringify({ codex: `fixture/test@sha256:${"a".repeat(64)}` }), SANDLANE_BROKER_STATE_DIR: "/tmp/test-state",
  SANDLANE_BROKER_SOCKET: "/tmp/test-api.sock", SANDLANE_BROKER_DOCKER_SOCKET: "/tmp/docker.sock" };

test("configuration refuses invalid quotas, label prefixes and mutable image tags", () => {
  assert.equal(brokerSettings(env).maxConcurrent, 5);
  assert.equal(brokerSettings(env).networkMode, "none");
  assert.equal(brokerSettings(env).labelPrefix, undefined);
  const claude = `fixture/claude@sha256:${"b".repeat(64)}`;
  assert.deepEqual(brokerSettings({ ...env, SANDLANE_BROKER_RUN_IMAGES: JSON.stringify({ codex: `fixture/test@sha256:${"a".repeat(64)}`, "claude-code": claude }) }).images,
    { codex: `fixture/test@sha256:${"a".repeat(64)}`, "claude-code": claude });
  assert.equal(brokerSettings({ ...env, SANDLANE_LABEL_PREFIX: "org.example.lane" }).labelPrefix, "org.example.lane");
  assert.equal(brokerSettings({ ...env, SANDLANE_BROKER_NETWORK_MODE: "isolated" }).networkMode, "isolated");
  assert.throws(() => brokerSettings({ ...env, SANDLANE_BROKER_NETWORK_MODE: "bridge" }));
  assert.throws(() => brokerSettings({ ...env, SANDLANE_BROKER_RELAY_BINDING: "{}" }));
  const relay = { containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, policyDigest: "c".repeat(64) };
  assert.deepEqual(brokerSettings({ ...env, SANDLANE_BROKER_NETWORK_MODE: "isolated", SANDLANE_BROKER_RELAY_BINDING: JSON.stringify(relay) }).relay, relay);
  assert.equal(brokerSettings({ ...env, SANDLANE_BROKER_MAX_CONCURRENT: "8", SANDLANE_BROKER_PER_TENANT: "3" }).perTenant, 3);
  for (const change of [{ SANDLANE_BROKER_MAX_CONCURRENT: "-1" }, { SANDLANE_BROKER_PER_TENANT: "6" }, { SANDLANE_BROKER_RUN_IMAGES: JSON.stringify({ codex: "test:latest" }) },
    { SANDLANE_BROKER_RUN_IMAGES: "{}" }, { SANDLANE_BROKER_RUN_IMAGES: JSON.stringify({ "Bad Id": claude }) }, { SANDLANE_BROKER_RUN_IMAGES: "[]" },
    { SANDLANE_BROKER_RUN_IMAGE: `fixture/test@sha256:${"a".repeat(64)}` },
    { SANDLANE_LABEL_PREFIX: "Bad Prefix" }, { SANDLANE_BROKER_STATE_DIR: "/" }, { SANDLANE_BROKER_DOCKER_SOCKET: "tcp://localhost:2375" }]) {
    assert.throws(() => brokerSettings({ ...env, ...change }));
  }
});

test("secrets support private files and reject exposure, symlinks and ambiguous sources", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "token"); const secret = "a".repeat(64);
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  assert.equal(await readSecret({ TEST_FILE: file }, "TEST"), secret);
  assert.equal(await readSecret({ TEST: secret }, "TEST"), secret);
  await assert.rejects(readSecret({ TEST: secret, TEST_FILE: file }, "TEST"), /not both/);
  await chmod(file, 0o644);
  await assert.rejects(readSecret({ TEST_FILE: file }, "TEST"), /private/);
  await chmod(file, 0o600);
  const link = path.join(root, "link"); await symlink(file, link);
  await assert.rejects(readSecret({ TEST_FILE: link }, "TEST"));
  await assert.rejects(readSecret({ TEST: "short" }, "TEST"), /32/);
});

test("state lock excludes a second Broker regardless of socket configuration", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireStateLock(root);
  await assert.rejects(acquireStateLock(root), { code: "EEXIST" });
  await release(); await release();
  await (await acquireStateLock(root))();
  await chmod(root, 0o755);
  await assert.rejects(acquireStateLock(root), /private/);
});

test("sandbox resources: workspace size and per-harness memory limits, validated", () => {
  assert.equal(brokerSettings(env).workspaceMiB, 96);
  assert.deepEqual(brokerSettings(env).memoryMiB, {});
  assert.equal(brokerSettings({ ...env, SANDLANE_BROKER_WORKSPACE_MIB: "128" }).workspaceMiB, 128);
  assert.deepEqual(brokerSettings({ ...env, SANDLANE_BROKER_RUN_MEMORY_MIB: '{"codex":256}' }).memoryMiB, { codex: 256 });
  for (const change of [{ SANDLANE_BROKER_WORKSPACE_MIB: "32" }, { SANDLANE_BROKER_WORKSPACE_MIB: "9999" },
    { SANDLANE_BROKER_RUN_MEMORY_MIB: '{"claude-code":512}' }, { SANDLANE_BROKER_RUN_MEMORY_MIB: '{"codex":64}' },
    { SANDLANE_BROKER_RUN_MEMORY_MIB: '{"codex":"256"}' }, { SANDLANE_BROKER_RUN_MEMORY_MIB: "[256]" },
    { SANDLANE_BROKER_WORKSPACE_MIB: "512", SANDLANE_BROKER_RUN_MEMORY_MIB: '{"codex":256}' }]) {
    assert.throws(() => brokerSettings({ ...env, ...change }), undefined, JSON.stringify(change));
  }
});
