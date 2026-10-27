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
import { ToolGateway } from '../dist/gateway/tool/gateway.js';
import { BoundUserToolSecrets } from '../dist/gateway/tool/secrets.js';

const capability = 'c'.repeat(43);
const runtime = { runtimeId: 'host-1', allocationId: 'allocation-1' };
const input = () => ({ callId: 'call-1', toolAlias: 'metadata.read', arguments: { code: 'demo.page' } });
function fixture(overrides = {}) {
  const receipts = [], calls = [], reads = [];
  const authority = {
    reserve: async ({ call, requestDigest }) => ({ tenantId: '1', userId: '11', subjectUserId: '11', runId: '21', attributes: { site: 'site-a' },
      actorTenantAccessId: '101', credentialOwnerTenantAccessId: '101',
      callId: call.callId, toolAlias: call.toolAlias, requestDigest, serverId: 'purefect',
      serverVersion: 1, targetRef: 'purefect-local', targetVersion: 1, toolVersion: 1,
      credentialRef: '${secret://field::pf.ai.userCredential#token}', credentialRow: 'user-11',
      bindingVersion: 1, credentialVersion: 1, expiresAt: Date.now() + 60000, receipt: 'r'.repeat(43), ...overrides }),
    dispatch: async () => {},
    finish: async receipt => { receipts.push(receipt); }
  };
  const secrets = { read: async permit => { reads.push(permit); return { accessToken: `token-for-${permit.userId}-`.padEnd(40, 'x'), expiresAt: Date.now() + 60000 }; } };
  const adapter = { validate: () => {}, invoke: async (call, identity, token) => { calls.push({ call, identity, token }); return { ok: true }; } };
  const build = limits => new ToolGateway(authority, secrets, new Map([['purefect', adapter]]), limits);
  return { authority, secrets, adapter, receipts, calls, reads, build };
}
test('valid field and vault bindings keep secrets out of results and receipts', async () => {
  for (const overrides of [{}, { credentialRef: '${secret://vault::user-11}', credentialRow: null }]) {
    const f = fixture(overrides);
    assert.deepEqual(await f.build().invoke(capability, runtime, input()), { ok: true });
    assert.equal(f.calls[0].identity.userId, '11');
    assert.equal(f.calls[0].identity.actorTenantAccessId, '101');
    assert.equal(f.receipts[0].outcome, 'SUCCEEDED');
    assert.deepEqual(f.receipts[0].runtime, runtime);
    assert.ok(!JSON.stringify(f.receipts).includes(f.calls[0].token));
  }
});
test('caller cannot select tenant, profile or credential row in the gateway envelope', async () => {
  for (const key of ['tenantId', 'profile', 'credentialRow', 'credentialRef', 'userId', 'actorTenantAccessId', 'credentialOwnerTenantAccessId']) {
    const f = fixture();
    await assert.rejects(f.build().invoke(capability, runtime, { ...input(), [key]: 'victim' }));
    assert.equal(f.reads.length, 0);
  }
});
test('another user credential, expired grant, missing row and legacy references fail closed', async () => {
  for (const override of [{ subjectUserId: '12' }, { expiresAt: 1 }, { credentialRow: null },
    { credentialRef: '${secret://shared}' }, { credentialRef: 'secret://global' }, { bindingVersion: 0 },
    { credentialVersion: undefined }, { credentialVersion: 0 }, { serverVersion: undefined },
    { targetRef: 'https://attacker' }, { targetVersion: 0 }, { toolVersion: 1.5 }]) {
    const f = fixture(override);
    await assert.rejects(f.build().invoke(capability, runtime, input()));
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
});
test('revocation during secret lookup prevents sending and sanitizes the error', async () => {
  const f = fixture();
  f.authority.dispatch = async () => { throw new Error('private-token-and-URL'); };
  await assert.rejects(f.build().invoke(capability, runtime, input()), { message: 'TOOL_CALL_REJECTED' });
  assert.equal(f.reads.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.receipts[0].outcome, 'FAILED');
});
test('missing credential never falls back to a personal profile', async () => {
  const f = fixture(); f.secrets.read = async () => { throw new Error('not configured'); };
  await assert.rejects(f.build().invoke(capability, runtime, input()));
  assert.equal(f.calls.length, 0); assert.equal(f.receipts[0].outcome, 'FAILED');
});
test('tool-specific validation runs before reading credentials', async () => {
  const f = fixture(); f.adapter.validate = () => { throw new Error('profile is forbidden'); };
  await assert.rejects(f.build().invoke(capability, runtime, input()));
  assert.equal(f.reads.length, 0);
});
test('sent failures and credential echoes are UNKNOWN, with no retry', async () => {
  for (const echo of [false, true]) {
    const f = fixture(); let sends = 0;
    f.adapter.invoke = async (_call, _identity, token) => { sends++; if (echo) return { token }; throw new Error(token); };
    await assert.rejects(f.build().invoke(capability, runtime, input()), { message: 'TOOL_RESULT_UNKNOWN' });
    assert.equal(sends, 1); assert.equal(f.receipts[0].outcome, 'UNKNOWN');
  }
});
test('receipt failure does not publish success or overwrite the uncertain receipt', async () => {
  const f = fixture(); let attempts = 0;
  f.authority.finish = async () => { attempts++; throw new Error('db unavailable'); };
  await assert.rejects(f.build().invoke(capability, runtime, input()), { message: 'TOOL_RECEIPT_UNCONFIRMED' });
  assert.equal(attempts, 1); assert.equal(f.calls.length, 1);
});
test('parallel users keep their own credentials, identities and immutable arguments', async () => {
  const f = fixture(); const base = f.authority.reserve;
  f.authority.reserve = async request => { const p = await base(request); const user = request.call.callId === 'one' ? '11' : '12';
    return { ...p, userId: user, subjectUserId: user, actorTenantAccessId: '10' + user,
      credentialOwnerTenantAccessId: '10' + user, credentialRow: 'user-' + user }; };
  f.secrets.read = async p => { await new Promise(r => setTimeout(r, p.userId === '11' ? 15 : 1));
    return { accessToken: ('token-' + p.userId).padEnd(40, 'x'), expiresAt: Date.now() + 10000 }; };
  const gateway = f.build(), first = { ...input(), callId: 'one' }, second = { ...input(), callId: 'two' };
  const a = gateway.invoke(capability, runtime, first), b = gateway.invoke(capability, runtime, second);
  first.arguments.code = 'mutated';
  await Promise.all([a, b]);
  for (const call of f.calls) {
    assert.equal(call.call.arguments.code, 'demo.page');
    assert.equal(call.token, ('token-' + call.identity.userId).padEnd(40, 'x'));
    assert.equal(call.identity.actorTenantAccessId, '10' + call.identity.userId);
  }
});
test('aborted callers do not reserve or read credentials', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  let reserve = 0; f.authority.reserve = async () => { reserve++; throw new Error(); };
  await assert.rejects(f.build().invoke(capability, runtime, input(), controller.signal));
  assert.equal(reserve, 0); assert.equal(f.reads.length, 0);
});
test('credential expiry during final authorization prevents transport', async () => {
  const f = fixture();
  f.secrets.read = async () => ({ accessToken: 'a'.repeat(40), expiresAt: Date.now() + 5 });
  f.authority.dispatch = async () => { await new Promise(r => setTimeout(r, 15)); };
  await assert.rejects(f.build().invoke(capability, runtime, input()));
  assert.equal(f.calls.length, 0);
});

test('bound secret sources route explicit references and reject cross-user or stale source results', async () => {
  for (const source of ['vault', 'field']) for (const override of [null, { userId: '12' }, { tenantId: '2' },
    { serverId: 'other' }, { bindingVersion: 2 }, { active: false }, { expiresAt: 1 },
    { ownerTenantAccessId: '102' }, { ownerTenantAccessId: undefined },
    { credentialVersion: 2 }, { credentialVersion: undefined }]) {
    const f = fixture(source === 'vault' ? { credentialRef: '${secret://vault::user/11}', credentialRow: null } : {});
    let vaultReads = 0, fieldReads = 0;
    const value = p => ({ tenantId: p.tenantId, userId: p.userId, serverId: p.serverId, bindingVersion: 1,
      ownerTenantAccessId: p.actorTenantAccessId, credentialVersion: 1,
      active: true, accessToken: 't'.repeat(40), expiresAt: Date.now() + 60000, ...override });
    const secrets = new BoundUserToolSecrets({
      vault: async ({ permit, code }) => { vaultReads++; assert.equal(code, 'user/11'); return value(permit); },
      field: async ({ permit, model, field, row }) => { fieldReads++; assert.equal(model, 'pf.ai.userCredential');
        assert.equal(field, 'token'); assert.equal(row, 'user-11'); return value(permit); }
    });
    const g = new ToolGateway(f.authority, secrets, new Map([['purefect', f.adapter]]));
    if (override) { await assert.rejects(g.invoke(capability, runtime, input())); assert.equal(f.calls.length, 0); }
    else assert.deepEqual(await g.invoke(capability, runtime, input()), { ok: true });
    assert.equal(vaultReads, source === 'vault' ? 1 : 0); assert.equal(fieldReads, source === 'field' ? 1 : 0);
  }
});

test('membership must be explicit and cannot reuse a credential after membership recreation', async () => {
  for (const override of [{ actorTenantAccessId: undefined }, { actorTenantAccessId: '0' },
    { actorTenantAccessId: '102' }, { credentialOwnerTenantAccessId: undefined }]) {
    const f = fixture(override);
    await assert.rejects(f.build().invoke(capability, runtime, input()));
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('direct secret port rejects absent or mismatched membership before consulting a source', async () => {
  let reads = 0;
  const source = async () => { reads++; throw new Error('must not resolve'); };
  const secrets = new BoundUserToolSecrets({ vault: source, field: source });
  const p = await fixture().authority.reserve({ call: input(), requestDigest: 'unused' });
  for (const override of [{ actorTenantAccessId: undefined, credentialOwnerTenantAccessId: undefined },
    { credentialOwnerTenantAccessId: '102' }]) {
    await assert.rejects(secrets.read({ ...p, ...override }, new AbortController().signal));
  }
  assert.equal(reads, 0);
});

test('a slow transport ignoring cancellation remains UNKNOWN and cannot publish a late answer', async () => {
  const f = fixture(); let sends = 0;
  f.adapter.invoke = async () => { sends++; await new Promise(r => setTimeout(r, 30)); return { late: true }; };
  await assert.rejects(f.build({ concurrent: 1, timeoutMs: 10, receiptMs: 100 }).invoke(capability, runtime, input()),
    { message: 'TOOL_RESULT_UNKNOWN' });
  assert.equal(sends, 1); assert.equal(f.receipts[0].outcome, 'UNKNOWN');
});
