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
// Real Purefect managed client against disposable local HTTPS; no platform/business credentials.
// Usage: node scripts/purefect-managed-transport-smoke.js /absolute/path/to/purefect-client/lib/purefect_client.js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { ManagedPurefectReadAdapter } from '../dist/plugins/purefect/purefect-adapter.js';
import { ToolGateway } from '../dist/gateway/tool/gateway.js';

if (!process.argv[2] || !isAbsolute(process.argv[2])) throw Error('Explicit absolute managed client module required');
const PurefectClient = createRequire(import.meta.url)(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'sandlane-managed-transport-'));
let server;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'));
  const requests = [], receipts = [];
  server = https.createServer({ key: await readFile(join(dir, 'key.pem')), cert }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ token: req.headers.authorization, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url.includes('::redirect')) { res.writeHead(302, { location: '/trap' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: { marker: requests.at(-1).body.marker } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const adapter = new ManagedPurefectReadAdapter(`https://127.0.0.1:${server.address().port}`,
    ['get', 'redirect'].map(op => ({
      alias: `test.${op}`, version: 1, apiCode: `test::${op}`, readOnly: true,
      validateParams(p) { assert.deepEqual(Object.keys(p), ['marker']); assert.equal(typeof p.marker, 'string'); }
    })), config => new PurefectClient({ ...config, ca: cert }),
    { serverId: 'purefect', targetRef: 'local-test', targetVersion: 1 });
  const authority = {
    async reserve({ call, requestDigest }) {
      const tenant = call.callId === 'two' ? '2' : '1';
      return { tenantId: tenant, userId: tenant + '1', subjectUserId: tenant + '1',
        actorTenantAccessId: tenant + '01', credentialOwnerTenantAccessId: tenant + '01', runId: tenant + '21',
        attributes: { tenant_code: tenant === '1' ? 'tenant-one' : 'tenant-two', site: 'site-a' },
        callId: call.callId, toolAlias: call.toolAlias, requestDigest, serverId: 'purefect',
        serverVersion: 1, targetRef: 'local-test', targetVersion: 1, toolVersion: 1,
        credentialRef: '${secret://vault::test}', credentialRow: null, bindingVersion: 1, credentialVersion: 1,
        expiresAt: Date.now() + 60000, receipt: 'r'.repeat(43) };
    },
    async dispatch() {}, async finish(r) { receipts.push(r.outcome); }
  };
  const gateway = new ToolGateway(authority, { async read(p) {
    return { accessToken: p.tenantId.repeat(40), expiresAt: Date.now() + 60000 };
  } }, new Map([['purefect', adapter]]));
  const invoke = (callId, toolAlias = 'test.get') => gateway.invoke('c'.repeat(43),
    { runtimeId: 'host', allocationId: 'allocation' }, { callId, toolAlias, arguments: { marker: callId } });
  await Promise.all([invoke('one'), invoke('two')]);
  assert.equal(requests.length, 2);
  for (const [marker, tenant, token] of [['one', 'tenant-one', '1'], ['two', 'tenant-two', '2']]) {
    const request = requests.find(r => r.body.marker === marker);
    assert.ok(request.url.includes(tenant)); assert.ok(request.url.includes('site-a'));
    assert.ok(request.token.includes(token.repeat(40)));
  }
  await assert.rejects(invoke('redirect', 'test.redirect'), { message: 'TOOL_RESULT_UNKNOWN' });
  assert.equal(requests.length, 3); assert.ok(!requests.some(r => r.url === '/trap'));
  assert.deepEqual(receipts.sort(), ['SUCCEEDED', 'SUCCEEDED', 'UNKNOWN']);
  console.log('PASS: independent tenant/user credentials over verified HTTPS; redirect refused; UNKNOWN without retry. Authority is a fixture, not production IAM.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(dir, { recursive: true, force: true });
}
