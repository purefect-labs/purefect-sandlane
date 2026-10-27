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
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedPurefectAdapter } from '../dist/plugins/purefect/purefect-adapter.js';

const rule = () => ({ alias: 'meta.read', version: 1, readOnly: true, description: 'Read.', inputSchema: { type: 'object' },
  validateParams(p) { if (Object.keys(p).join(',') !== 'code' || typeof p.code !== 'string') throw new Error('schema'); },
  call: (args, client) => client().request('pf.test.Meta::get', args) });
const call = { callId: 'call', toolAlias: 'meta.read', arguments: { code: 'demo' } };
const deployment = { serverId: 'purefect', targetRef: 'local', targetVersion: 3 };
const identity = { tenantId: '1', userId: '11', actorTenantAccessId: '101', runId: '21',
  attributes: { tenant_code: 'tenant-one', site: 'site-a' }, ...deployment, serverVersion: 2, toolVersion: 1 };
const signal = () => new AbortController().signal;

test('managed adapter freezes configuration and creates a distinct client for every user call', async () => {
  const seen = [], tool = rule();
  const adapter = new ManagedPurefectAdapter('https://localhost:8443', [tool], config => {
    seen.push(config); assert.ok(Object.isFrozen(config));
    return { request: async (api, params) => ({ api, code: params.code }) };
  }, deployment);
  tool.call = (args, client) => client().request('pf.test.Meta::delete', args);
  const result = await Promise.all(['a', 'b'].map((token, index) => adapter.invoke(call,
    { ...identity, userId: String(11 + index), actorTenantAccessId: String(101 + index) }, token.repeat(40), signal(), Date.now() + 60000)));
  assert.ok(result.every(r => r.api === 'pf.test.Meta::get'));
  assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]);
  assert.equal(seen[0].accessToken, 'a'.repeat(40)); assert.equal(seen[1].accessToken, 'b'.repeat(40));
  assert.ok(seen.every(c => c.tenantCode === 'tenant-one' && c.loginSite === 'site-a' && c.mode === 'managed' && c.timeout <= 30000));
});

test('unpublished API, parameter overrides, unknown tenant and expired token never create a client', async () => {
  let created = 0;
  const adapter = new ManagedPurefectAdapter('https://localhost', [rule()], () => { created++; throw Error(); }, deployment);
  for (const [input, who, expiry] of [[{ ...call, toolAlias: 'purefect_call' }, identity, Date.now() + 10000],
    [{ ...call, arguments: { code: 'demo', api_code: 'sys::delete' } }, identity, Date.now() + 10000],
    [call, { ...identity, attributes: { site: 'site-a' } }, Date.now() + 10000], [call, identity, 1]]) {
    await assert.rejects(adapter.invoke(input, who, 'x'.repeat(40), signal(), expiry));
  }
  assert.equal(created, 0);
});

test('adapter refuses insecure origins, unclassified or callless tools and duplicate aliases', () => {
  const build = (url, rules) => new ManagedPurefectAdapter(url, rules, () => { throw Error(); }, deployment);
  for (const url of ['http://localhost', 'https://user:pass@localhost', 'https://localhost/path', 'https://localhost/?q=x']) {
    assert.throws(() => build(url, [rule()]));
  }
  for (const rules of [[{ ...rule(), readOnly: undefined }], [{ ...rule(), call: undefined }], [rule(), rule()],
    [{ ...rule(), alias: 'bad alias' }]]) {
    assert.throws(() => build('https://localhost', rules));
  }
  // Writable tools are allowed: the platform authorizes the Run owner's token.
  assert.doesNotThrow(() => build('https://localhost', [{ ...rule(), readOnly: false }]));
});

test('cancelled calls do not construct a client or release a late successful result', async () => {
  let created = 0;
  const controller = new AbortController();
  const adapter = new ManagedPurefectAdapter('https://localhost', [rule()], () => {
    created++; return { request: async () => { controller.abort(); return { ok: true }; } };
  }, deployment);
  await assert.rejects(adapter.invoke(call, identity, 't'.repeat(40), controller.signal, Date.now() + 10000));
  await assert.rejects(adapter.invoke(call, identity, 't'.repeat(40), controller.signal, Date.now() + 10000));
  assert.equal(created, 1);
});
test('installed target and tool revisions are pinned while tenant publications may advance independently', async () => {
  let created = 0;
  const installed = { ...deployment };
  const adapter = new ManagedPurefectAdapter('https://localhost', [rule()], () => {
    created++; return { request: async () => ({ ok: true }) };
  }, installed);
  installed.targetVersion = 99;
  for (const override of [{ serverVersion: 0 }, { targetRef: 'other' }, { targetVersion: 99 }, { toolVersion: 2 }, { serverId: 'other' }]) {
    assert.throws(() => adapter.validate(call, { ...identity, ...override }));
    await assert.rejects(adapter.invoke(call, { ...identity, ...override }, 't'.repeat(40), signal(), Date.now() + 10000));
  }
  assert.equal(created, 0);
  assert.deepEqual(await adapter.invoke(call, identity, 't'.repeat(40), signal(), Date.now() + 10000), { ok: true });
  assert.deepEqual(await adapter.invoke(call, { ...identity, serverVersion: 7 }, 't'.repeat(40), signal(), Date.now() + 10000), { ok: true });
});

test('a named site reaches a separate client; a malformed one never does', async () => {
  const seen = [];
  const tool = { ...rule(), call: (args, client) => client(args.code === 'other' ? 'blis' : args.code === 'bad' ? '../x' : undefined)
    .request('pf.test.Meta::get', args) };
  const adapter = new ManagedPurefectAdapter('https://localhost', [tool], config => {
    seen.push(config.loginSite); return { request: async () => ({ ok: true }) };
  }, deployment);
  await adapter.invoke({ ...call, arguments: { code: 'other' } }, identity, 't'.repeat(40), signal(), Date.now() + 10000);
  await adapter.invoke(call, identity, 't'.repeat(40), signal(), Date.now() + 10000);
  await assert.rejects(adapter.invoke({ ...call, arguments: { code: 'bad' } }, identity, 't'.repeat(40), signal(), Date.now() + 10000),
    /PUREFECT_TOOL_REJECTED/);
  assert.deepEqual(seen, ['blis', 'site-a']);
});
