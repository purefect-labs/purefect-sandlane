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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolGateway } from '../dist/gateway/tool/gateway.js';
import {
  ApiDocs,
  apiDocsDirectory,
  installPurefectTools,
  PUREFECT_TOOL_NAMES
} from '../dist/plugins/purefect/purefect-catalog.js';

const config = { gateway: 'https://localhost:8443', targetRef: 'platform-dev', targetVersion: 3 };
const deployment = { serverId: 'purefect', serverVersion: 7, targetRef: 'platform-dev', targetVersion: 3, toolVersion: 1 };
const capability = 'c'.repeat(43);
const runtime = { runtimeId: 'host', allocationId: 'allocation' };
const GET_RAW = 'pf.designer.meta.MetaManager::get_raw';

async function docsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandlane-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apis', 'meta'), { recursive: true });
  await mkdir(path.join(root, 'apis', 'auth'), { recursive: true });
  await writeFile(path.join(root, 'apis', 'meta', 'replace.md'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  await writeFile(path.join(root, 'apis', 'meta', 'notes.txt'), 'not a doc');
  await writeFile(path.join(root, 'apis', 'auth', 'login.md'), '# login');
  await writeFile(path.join(root, 'apis', 'big.md'), 'x'.repeat(1024 * 1024 + 1));
  await writeFile(path.join(root, 'apis', 'wide.md'), Array.from({ length: 400 }, () => 'y'.repeat(300)).join('\n'));
  await writeFile(path.join(root, 'secret.md'), 'outside the docs');
  await symlink(path.join(root, 'secret.md'), path.join(root, 'apis', 'meta', 'escape.md'));
  return { root, docs: await ApiDocs.open(path.join(root, 'apis')) };
}

async function fixture(t, respond = (api, params) => ({ success: true, data: { api, params } })) {
  const { docs } = await docsRoot(t);
  const reads = [], requests = [], receipts = [], audit = [];
  const authority = {
    async reserve({ call, requestDigest }) {
      const tenant = call.callId === 'two' ? '2' : '1';
      return { ...deployment, serverVersion: tenant === '1' ? 7 : 12, tenantId: tenant, userId: tenant + '1', subjectUserId: tenant + '1',
        actorTenantAccessId: tenant + '01', credentialOwnerTenantAccessId: tenant + '01', runId: tenant + '21',
        attributes: { tenant_code: tenant === '1' ? 'one' : 'two', site: 'site-a' },
        callId: call.callId, toolAlias: call.toolAlias, requestDigest, credentialRef: '${secret://vault::test}', credentialRow: null,
        bindingVersion: 1, credentialVersion: 1, expiresAt: Date.now() + 30000, receipt: 'r'.repeat(43) };
    },
    async dispatch() {}, async finish(result) { receipts.push(result.outcome); },
  };
  const secrets = { async read(permit) { reads.push(permit.userId); return { accessToken: permit.userId.padEnd(40, 'x'), expiresAt: Date.now() + 10000 }; } };
  const factory = settings => ({ async request(api, params) { requests.push({ settings, api, params }); return respond(api, params); } });
  const installed = installPurefectTools({ ...config, docs }, factory);
  const gateway = new ToolGateway(authority, secrets, new Map([['purefect', installed.adapter]]), undefined,
    entry => audit.push(entry));
  let serial = 0;
  const invoke = (tool, args, id = `call-${++serial}`) =>
    gateway.invoke(capability, runtime, { callId: id, toolAlias: tool, arguments: args });
  return { installed, gateway, invoke, reads, requests, receipts, audit };
}

test('every Purefect tool is installed: one generic API call (may write), the read-only docs and read_skill', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.installed.adapter.tools.map(tool => [tool.alias, tool.readOnly]),
    [['purefect_call', false], ['list_api_docs', true], ['read_api_doc', true], ['read_skill', true]]);
  assert.deepEqual(PUREFECT_TOOL_NAMES, ['purefect_call', 'list_api_docs', 'read_api_doc', 'read_skill']);
  assert.ok(Object.isFrozen(f.installed.inventory.targets[0].tools[0]));
  assert.ok(!JSON.stringify(f.installed.inventory).includes(config.gateway));
  // Business runs read metadata through the runtime summary; replace rules live in the doc.
  const call = f.installed.adapter.tools[0];
  assert.match(call.description, /prefer the compact MetaManager::get_meta_summary/);
  assert.match(call.description, /read apis\/meta\/replace\.md/);
  assert.doesNotMatch(call.description, /get_raw first/);
  assert.match(call.inputSchema.properties.api_code.description, /get_meta_summary/);
  assert.match(call.description, /list_api_docs then read_api_doc/);
  assert.deepEqual(Object.keys(call.inputSchema.properties), ['api_code', 'params', 'site']);
  assert.equal(apiDocsDirectory('/opt/purefect-client/lib/purefect_client.js'), '/opt/purefect-client/apis');
});

test('read_skill asks the platform for one skill of this Run with the Run owner\'s token', async t => {
  const f = await fixture(t);
  await f.invoke('read_skill', { code: 'quote_rules' });
  assert.equal(f.requests.at(-1).api, 'sys.ai.run.skill');
  assert.deepEqual(f.requests.at(-1).params, { code: 'quote_rules' });
  assert.equal(f.requests.at(-1).settings.loginSite, 'site-a');
  for (const args of [{}, { code: '' }, { code: '../x' }, { code: 'a', extra: 1 }])
    await assert.rejects(f.invoke('read_skill', args), /TOOL_CALL_REJECTED/);
});

test('purefect_call reaches any API as the Run owner, on the lease site or a named one', async t => {
  const f = await fixture(t);
  await Promise.all(['one', 'two'].map(id =>
    f.invoke('purefect_call', { api_code: 'blis.md.product::search', params: { keyword: id } }, id)));
  assert.equal(f.requests.length, 2);
  for (const item of f.requests) {
    assert.equal(item.api, 'blis.md.product::search');
    assert.equal(item.settings.mode, 'managed');
    assert.equal(item.settings.loginSite, 'site-a');
    assert.equal(item.settings.accessToken, (item.settings.tenantCode === 'one' ? '11' : '21').padEnd(40, 'x'));
  }
  await f.invoke('purefect_call', { api_code: GET_RAW, params: { type: 'model', code: 'x' }, site: 'blis' });
  assert.equal(f.requests.at(-1).settings.loginSite, 'blis');
  // Omitted params are an empty body, as in purefect-client.
  await f.invoke('purefect_call', { api_code: 'pf.basis.user::current' });
  assert.deepEqual(f.requests.at(-1).params, {});
  // Nested Domain members: Domain::member::service.
  await f.invoke('purefect_call', { api_code: 'pf.basis.user.UserDomain::my_mail_manager::list_mail', params: { since_days: 1 } });
  assert.equal(f.requests.at(-1).api, 'pf.basis.user.UserDomain::my_mail_manager::list_mail');
  assert.deepEqual(f.receipts, ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  // Audit: run, tool, API code and outcome only; never parameters or results.
  assert.deepEqual(
    f.audit.map(e => [e.run, e.tool, e.fields.api_code, e.outcome]).at(-1),
    ['121', 'purefect_call', 'pf.basis.user.UserDomain::my_mail_manager::list_mail', 'SUCCEEDED']
  );
  assert.ok(!JSON.stringify(f.audit).includes('keyword'));
});

test('purefect_call rejects overrides and malformed calls before any credential is read', async t => {
  const f = await fixture(t);
  for (const args of [{ api_code: GET_RAW, tenant_code: 'other' }, { api_code: GET_RAW, profile: 'victim' },
    { api_code: 'https://other/api' }, { api_code: GET_RAW, params: [] }, { api_code: GET_RAW, site: '../x' },
    { api_code: GET_RAW, params: { blob: 'x'.repeat(31_990) } }, { params: {} }]) {
    await assert.rejects(f.invoke('purefect_call', args), /TOOL_CALL_REJECTED/, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0);
});

test('platform failures reach the model as codes: definite refusals FAILED, transport UNKNOWN', async t => {
  const outcomes = { 'a::denied': 'MANAGED_API_FAILED', 'a::http': 'MANAGED_HTTP_REJECTED', 'a::slow': 'MANAGED_TIMEOUT' };
  const f = await fixture(t, api => { throw new Error(outcomes[api] ?? 'private detail https://x'); });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::denied' }), { code: 'PLATFORM_API_FAILED', definite: true });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::http' }), { code: 'PLATFORM_HTTP_REJECTED', definite: true });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::slow' }), { code: 'PLATFORM_TIMEOUT', definite: false });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::other' }), { code: 'TOOL_RESULT_UNKNOWN' });
  assert.deepEqual(f.receipts, ['FAILED', 'FAILED', 'UNKNOWN', 'UNKNOWN']);
  assert.deepEqual(f.audit.map(e => e.code), ['PLATFORM_API_FAILED', 'PLATFORM_HTTP_REJECTED', 'PLATFORM_TIMEOUT', undefined]);
  assert.ok(!JSON.stringify(f.audit).includes('private detail'));
});

test('a platform refusal carries its fault code as the reason; malformed codes are dropped', async t => {
  const faults = { 'a::ref': 'file_reference_invalid', 'a::odd': 'x <b> https://internal' };
  const f = await fixture(t, api => { throw Object.assign(new Error('MANAGED_API_FAILED'), { platformFault: faults[api] }); });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::ref' }),
    { code: 'PLATFORM_API_FAILED', definite: true, reason: 'file_reference_invalid' });
  await assert.rejects(f.invoke('purefect_call', { api_code: 'a::odd' }),
    e => e.code === 'PLATFORM_API_FAILED' && e.reason === undefined);
  assert.ok(!JSON.stringify(f.audit).includes('internal'));
});

test('an oversized result completes with a note instead of a failure', async t => {
  const f = await fixture(t, () => ({ success: true, data: 'z'.repeat(70_000) }));
  const result = await f.invoke('purefect_call', { api_code: GET_RAW, params: { type: 'model', code: 'big' } });
  assert.equal(result.result_omitted, 'TOOL_RESULT_TOO_LARGE');
  assert.ok(result.bytes > 70_000);
  assert.deepEqual(f.receipts, ['SUCCEEDED']);
});

test('API docs: list and read markdown under apis/ only, bounded', async t => {
  const f = await fixture(t);
  const tree = await f.invoke('list_api_docs', {});
  assert.match(tree, /replace\.md {2}-> {2}apis\/meta\/replace\.md/);
  // The first "# " heading follows the file name, so a listing says what each file covers.
  assert.match(tree, /login\.md — login {2}-> {2}apis\/auth\/login\.md/);
  assert.ok(!tree.includes('notes.txt'));
  const meta = await f.invoke('list_api_docs', { module: 'meta' });
  assert.ok(meta.includes('replace.md') && !meta.includes('login.md') && !meta.includes('big.md'));
  assert.equal(await f.invoke('read_api_doc', { path: 'meta/replace.md', start_line: 3, line_count: 2 }),
    '[meta/replace.md lines 3-4 of 10]\nline 3\nline 4');
  assert.match(await f.invoke('read_api_doc', { path: 'apis/auth/login.md' }), /# login$/);
  // Output stays under its byte budget; the model is told where to continue.
  const wide = await f.invoke('read_api_doc', { path: 'wide.md', line_count: 500 });
  assert.ok(Buffer.byteLength(wide) < 48_000);
  assert.match(wide, /continue with start_line=\d+\]$/);
  assert.deepEqual(f.audit.map(e => e.fields), [{}, { module: 'meta' }, { doc: 'meta/replace.md' },
    { doc: 'apis/auth/login.md' }, { doc: 'wide.md' }]);
});

test('API docs refuse traversal, links out of apis/, other files and oversized documents', async t => {
  const { root, docs } = await docsRoot(t);
  for (const [doc, code] of [['../secret.md', 'DOC_PATH_REJECTED'], ['meta/../../secret.md', 'DOC_PATH_REJECTED'],
    [path.join(root, 'secret.md'), 'DOC_PATH_REJECTED'], ['meta/escape.md', 'DOC_PATH_REJECTED'],
    ['meta/notes.txt', 'DOC_PATH_REJECTED'], ['meta', 'DOC_PATH_REJECTED'], ['missing.md', 'DOC_NOT_FOUND'],
    ['big.md', 'DOC_TOO_LARGE']]) {
    await assert.rejects(docs.read(doc), { code }, doc);
  }
  const f = await fixture(t);
  for (const [tool, args] of [['read_api_doc', { path: 'meta/replace.md', line_count: 501 }],
    ['read_api_doc', { path: 'a\u0000.md' }], ['read_api_doc', { path: '' }],
    ['read_api_doc', { path: 'meta/replace.md', extra: 1 }], ['list_api_docs', { module: '../' }]]) {
    await assert.rejects(f.invoke(tool, args), /TOOL_CALL_REJECTED/);
  }
  await assert.rejects(ApiDocs.open('relative/apis'));
  await assert.rejects(ApiDocs.open(path.join(root, 'missing')));
});
