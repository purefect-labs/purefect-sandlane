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
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createToolMcpServer } from '../dist/gateway/tool/mcp-server.js';
import { ToolGateway } from '../dist/gateway/tool/gateway.js';
import { ApiDocs, installPurefectTools } from '../dist/plugins/purefect/purefect-catalog.js';

const CALL = { api_code: 'pf.designer.meta.MetaManager::get_raw', params: { type: 'page', code: 'demo.page' } };

async function fixture(t, hang = false, confirm = undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandlane-mcp-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apis', 'meta'), { recursive: true });
  await writeFile(path.join(root, 'apis', 'meta', 'replace.md'), '# replace\nFull replacement.\n');
  const docs = await ApiDocs.open(path.join(root, 'apis'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const [key, cert] = await Promise.all(['key', 'cert'].map(name => readFile(path.join(root, `${name}.pem`))));
  const entries = new Map(['a', 'b'].map((v, i) => [v.repeat(43), { runtime: { runtimeId: 'host', allocationId: `allocation-${i}` },
    expiresAt: Date.now() + 30000, enabledTools: i ? ['purefect_call', 'read_api_doc'] : ['purefect_call'] }]));
  const calls = [], downstream = [], receipts = [], actions = [];
  // A Run offered the page tool and no gateway tool: the action resolves through its own lane.
  entries.set('c'.repeat(43), { runtime: { runtimeId: 'host', allocationId: 'allocation-2' }, expiresAt: Date.now() + 30000,
    enabledTools: [], clientAction: { name: 'workspace_action', description: 'Operate pages.',
      inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['describe'] } }, required: ['op'] },
      expiresAt: Date.now() + 30000,
      async call(args) { actions.push(args); return { actionId: 'act_1', status: 'succeeded', result: { page: 'orders' } }; } } });
  // A Run offered control tools only (answered by its lane through the control plane).
  const controlCalls = [];
  entries.set('d'.repeat(43), { runtime: { runtimeId: 'host', allocationId: 'allocation-3' }, expiresAt: Date.now() + 30000,
    enabledTools: [], controlTools: [{ name: 'report_task', description: 'Report the task.',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      expiresAt: Date.now() + 30000,
      async call(args, _signal, callId) {
        controlCalls.push({ args, callId });
        if (args.status === 'boom') throw new Error('private-lane-details');
        return args.status === 'bad' ? { text: 'Invalid arguments', failed: true } : { text: 'Recorded' };
      } }] });
  let markStarted, markSettled;
  const started = new Promise(resolve => { markStarted = resolve; });
  const settled = new Promise(resolve => { markSettled = resolve; });
  const authority = {
    async reserve(input) {
      calls.push(input);
      const binding = entries.get(input.capability);
      if (!binding || binding.runtime.allocationId !== input.runtime.allocationId) throw Error('private-authority-details');
      const tenant = input.capability[0] === 'a' ? '1' : '2';
      return { tenantId: tenant, userId: tenant + '1', subjectUserId: tenant + '1', actorTenantAccessId: tenant + '01',
        credentialOwnerTenantAccessId: tenant + '01', runId: tenant + '21',
        attributes: { tenant_code: tenant === '1' ? 'one' : 'two', site: 'site-a' },
        serverId: 'purefect', serverVersion: 1, targetRef: 'test', targetVersion: 1, toolVersion: 1,
        callId: input.call.callId, toolAlias: input.call.toolAlias, requestDigest: input.requestDigest,
        credentialRef: '${secret://vault::test}', credentialRow: null, bindingVersion: 1, credentialVersion: 1,
        expiresAt: Date.now() + 10000, receipt: 'r'.repeat(43) };
    },
    async dispatch() {}, async finish(input) { receipts.push(input); markSettled(); },
    // Approval bridge of Run 'a' only (policy: get_raw); the others have none.
    ...(confirm ? { confirmation: input => input.capability[0] === 'a'
      ? { operations: ['*::get_raw'], confirm } : undefined } : {}),
  };
  const secrets = { async read(permit) { return { accessToken: permit.userId.padEnd(40, 'x'), expiresAt: Date.now() + 10000 }; } };
  const installed = installPurefectTools({ gateway: 'https://platform.example',
    targetRef: 'test', targetVersion: 1, docs }, settings => ({ async request(api, params) {
      downstream.push({ settings, api, params }); markStarted();
      if (hang) return new Promise(() => {});
      if (params.code === 'denied') throw new Error('MANAGED_API_FAILED');
      return { success: true, data: { code: params.code } };
    } }));
  const gateway = new ToolGateway(authority, secrets, new Map([['purefect', installed.adapter]]));
  const server = createToolMcpServer({ key, cert }, 'localhost', gateway, async token => entries.get(token) ?? null,
    installed.adapter.tools);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `https://localhost:${server.address().port}/mcp`;
  // Actual verified TLS sockets; never disable certificate verification, even in fixtures.
  const request = (body, overrides = {}, signal, method = 'POST') => new Promise((resolve, reject) => {
    const req = https.request(url, { ca: cert, servername: 'localhost', lookup: (_host, options, cb) => options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      method, signal, headers: { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', ...overrides }, }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  const makeClient = async token => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (_url, init) => {
        const result = await request(init.body, Object.fromEntries(new Headers(init.headers)), init.signal, init.method);
        return new Response(result.status === 202 || result.status === 204 ? null : result.text,
          { status: result.status, headers: result.headers });
      } });
    const client = new Client({ name: 'acceptance-client', version: '1' });
    await client.connect(transport); t.after(() => client.close()); return client;
  };
  return { entries, calls, receipts, downstream, actions, controlCalls, request, makeClient, started, settled };
}

test('MCP SDK clients over verified TLS isolate tool lists, allocations and downstream user credentials', async t => {
  const f = await fixture(t);
  const clients = await Promise.all(['a', 'b'].map(v => f.makeClient(v.repeat(43))));
  const lists = await Promise.all(clients.map(c => c.listTools()));
  assert.deepEqual(lists.map(l => l.tools.map(t => t.name)), [['purefect_call'], ['purefect_call', 'read_api_doc']]);
  // Writes are allowed (the platform authorizes the user's token): published as such.
  assert.deepEqual(lists[0].tools[0].annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.equal(lists[1].tools[1].annotations.readOnlyHint, true);
  const results = await Promise.all(clients.map((c, i) => c.callTool({ name: 'purefect_call',
    arguments: { ...CALL, params: { type: 'page', code: `demo.page${i}` } } })));
  assert.ok(results.every(r => !r.isError));
  assert.equal(f.downstream.length, 2); assert.equal(f.receipts.length, 2);
  assert.equal(new Set(f.calls.map(c => c.call.callId)).size, 2);
  for (const call of f.calls) assert.equal(call.runtime.allocationId, call.capability[0] === 'a' ? 'allocation-0' : 'allocation-1');
  for (const item of f.downstream) assert.equal(item.settings.accessToken, (item.settings.tenantCode === 'one' ? '11' : '21').padEnd(40, 'x'));
  assert.deepEqual(f.downstream.map(d => d.api), [CALL.api_code, CALL.api_code]);
  const denied = await clients[0].callTool({ name: 'read_api_doc', arguments: { path: 'meta/replace.md' } });
  assert.equal(denied.isError, true); assert.equal(f.calls.length, 2);
  // Documentation is returned as text, not as a JSON string.
  const doc = await clients[1].callTool({ name: 'read_api_doc', arguments: { path: 'apis/meta/replace.md' } });
  assert.equal(doc.content[0].text, '[meta/replace.md lines 1-3 of 3]\n# replace\nFull replacement.\n');
  // A platform refusal reaches the model as a code it can act on, never the dependency error.
  const failed = await clients[0].callTool({ name: 'purefect_call', arguments: { ...CALL, params: { code: 'denied' } } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /^The call failed \(PLATFORM_API_FAILED\)/);
  assert.deepEqual(f.receipts.at(-1).outcome, 'FAILED');
  f.entries.delete('a'.repeat(43));
  await assert.rejects(clients[0].listTools());
  assert.equal((await clients[1].listTools()).tools.length, 2);
});

test('MCP rejects browser origins, foreign hosts, identity injection, expired bindings and invalid tool arguments', async t => {
  const f = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'purefect_call', arguments: CALL } };
  for (const [overrides, status] of [[{ origin: 'https://attacker.example' }, 403], [{ host: 'attacker.example' }, 403],
    [{ authorization: 'Bearer wrong' }, 401], [{ 'mcp-session-id': 'another-user' }, 403], [{ 'content-encoding': 'gzip' }, 415]]) {
    const result = await f.request(body, overrides); assert.equal(result.status, status); assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal((await f.request({ ...body, tenantId: '2' })).status, 400);
  assert.equal((await f.request([body])).status, 400);
  assert.equal((await f.request('x'.repeat(72001))).status, 413);
  // Gateway tool calls keep the tool gateway's own bound; only a client action may carry more.
  const large = { ...body, params: { ...body.params, arguments: { ...CALL, params: { blob: 'x'.repeat(40000) } } } };
  assert.equal((await f.request(large)).status, 413);
  assert.equal((await f.request(Buffer.from([0xc0, 0xaf]))).status, 400);
  assert.equal((await f.request(body, { authorization: [`Bearer ${'a'.repeat(43)}`, `Bearer ${'b'.repeat(43)}`] })).status, 401);
  assert.equal((await f.request({ ...body, params: { ...body.params, runtime: { allocationId: 'other' } } })).status, 400);
  const badArgs = await f.request({ ...body, params: { ...body.params, arguments: { ...body.params.arguments, profile: 'other' } } });
  assert.equal(JSON.parse(badArgs.text).result.isError, true); assert.equal(f.calls.length, 0);
  assert.match(JSON.parse(badArgs.text).result.content[0].text, /^Invalid arguments/);
  // The model learns which rule failed (a fixed description, never its own input echoed back).
  assert.match(JSON.parse(badArgs.text).result.content[0].text, /api_code, params \(object\) and optional site/);
  f.entries.get('a'.repeat(43)).expiresAt = Date.now() - 1;
  assert.equal((await f.request(body)).status, 401); assert.equal(f.downstream.length, 0);
});

test('MCP disconnect cancels dispatched work and records UNKNOWN without retry or late success', { timeout: 5000 }, async t => {
  const f = await fixture(t, true);
  const abort = new AbortController();
  const result = f.request({ jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'purefect_call', arguments: CALL } }, {}, abort.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await f.started; abort.abort(); await rejected; await f.settled;
  assert.equal(f.calls.length, 1); assert.equal(f.downstream.length, 1);
  assert.deepEqual(f.receipts.map(r => r.outcome), ['UNKNOWN']);
});

test('the page tool is listed and callable only for the Run it was offered to', async t => {
  const f = await fixture(t);
  const [plain, page] = await Promise.all(['a', 'c'].map(v => f.makeClient(v.repeat(43))));
  assert.deepEqual((await plain.listTools()).tools.map(tool => tool.name), ['purefect_call']);
  const listed = (await page.listTools()).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['workspace_action']);
  assert.deepEqual(listed[0].inputSchema.properties.op.enum, ['describe']);
  // Another Run's capability cannot reach the action; nothing is relayed.
  const refused = await plain.callTool({ name: 'workspace_action', arguments: { op: 'describe' } });
  assert.equal(refused.isError, true); assert.equal(f.actions.length, 0);
  const receipt = await page.callTool({ name: 'workspace_action', arguments: { op: 'describe' } });
  assert.equal(receipt.isError, undefined);
  assert.deepEqual(JSON.parse(receipt.content[0].text), { actionId: 'act_1', status: 'succeeded', result: { page: 'orders' } });
  assert.deepEqual(f.actions, [{ op: 'describe' }]);
  // The gateway tools stay closed to a Run that has none.
  assert.equal((await page.callTool({ name: 'purefect_call', arguments: CALL })).isError, true);
  assert.equal(f.calls.length, 0);
  // A client action name may never shadow a gateway tool.
  f.entries.get('c'.repeat(43)).clientAction.name = 'purefect_call';
  await assert.rejects(page.listTools());
});

test('a call awaiting approval runs only once approved; a refusal reads as such, not as a permission error', async t => {
  const verdicts = ['rejected', 'timeout', 'unavailable', 'unattended', 'approved'], asked = [];
  const f = await fixture(t, false, async request => { asked.push(request); return verdicts.shift(); });
  f.entries.get('a'.repeat(43)).confirms = true;
  const client = await f.makeClient('a'.repeat(43));
  for (const [code, text] of [['CONFIRMATION_REJECTED', /user declined this call/], ['CONFIRMATION_TIMEOUT', /no answer arrived in time/],
    ['CONFIRMATION_UNAVAILABLE', /cannot be requested in this session/],
    ['CONFIRMATION_UNATTENDED', /an assigned task cannot ask for.*report_task/]]) {
    const refused = await client.callTool({ name: 'purefect_call', arguments: CALL });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, text);
    assert.ok(refused.content[0].text.includes(`(${code})`));
    assert.doesNotMatch(refused.content[0].text, /permission|Check the request/);
  }
  assert.equal(f.downstream.length, 0);
  const approved = await client.callTool({ name: 'purefect_call', arguments: CALL });
  assert.equal(approved.isError, undefined);
  assert.equal(f.downstream.length, 1);
  assert.deepEqual(asked.map(request => [request.kind, request.tool, request.title]).at(-1),
    ['tool_call', 'purefect_call', 'pf.designer.meta.MetaManager::get_raw']);
  assert.equal(asked.at(-1).summary, 'api_code: pf.designer.meta.MetaManager::get_raw\nparams: type="page", code="demo.page"');
});

test('control tools are listed and callable only for their Run; the CLI tool call ID comes from _meta', async t => {
  const f = await fixture(t);
  const [plain, control] = await Promise.all(['a', 'd'].map(v => f.makeClient(v.repeat(43))));
  assert.deepEqual((await control.listTools()).tools.map(tool => tool.name), ['report_task']);
  assert.deepEqual((await control.listTools()).tools[0].annotations,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  const refused = await plain.callTool({ name: 'report_task', arguments: { status: 'done' } });
  assert.equal(refused.isError, true); assert.equal(f.controlCalls.length, 0);
  // Claude Code sends the model's tool_use id as _meta["claudecode/toolUseId"].
  const done = await control.callTool({ name: 'report_task', arguments: { status: 'done' },
    _meta: { 'claudecode/toolUseId': 'toolu_01ABC' } });
  assert.equal(done.isError, undefined); assert.equal(done.content[0].text, 'Recorded');
  const bad = await control.callTool({ name: 'report_task', arguments: { status: 'bad' } });
  assert.equal(bad.isError, true); assert.equal(bad.content[0].text, 'Invalid arguments');
  // A lane failure never reaches the model.
  const boom = await control.callTool({ name: 'report_task', arguments: { status: 'boom' } });
  assert.equal(boom.isError, true); assert.doesNotMatch(boom.content[0].text, /private/);
  assert.deepEqual(f.controlCalls.map(c => c.callId), ['toolu_01ABC', undefined, undefined]);
  // Gateway tools stay closed to a Run that has none.
  assert.equal((await control.callTool({ name: 'purefect_call', arguments: CALL })).isError, true);
  assert.equal(f.calls.length, 0);
  // A control tool may never shadow a gateway tool.
  f.entries.get('d'.repeat(43)).controlTools[0].name = 'purefect_call';
  await assert.rejects(control.listTools());
});
