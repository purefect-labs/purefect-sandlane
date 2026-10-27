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
import { toolRequestDigest } from '../dist/gateway/tool/request-digest.js';

test('metadata read v1 matches the frozen Engine request digest vectors', () => {
  assert.equal(toolRequestDigest({ callId: 'call-1', toolAlias: 'metadata.get_raw', arguments: { type: 'model', code: 'pf.demo.Model' } }),
    '4b012222ddd2f444754f4a78112f5bb6981c658c4bfbd61f3e5f81087aac71e3');
  assert.equal(toolRequestDigest({ callId: 'call:2/path', toolAlias: 'metadata.get_meta', arguments: { type: 'page', code: 'pf.demo.Edit-Page' } }),
    '2a3c66b109b3c67379278d657bbd5947aad393ebab931ecccdd5c02b95aeba82');
});
test('wire property order cannot change the digest but actual tool or parameters do', () => {
  const a = { callId: 'call-1', toolAlias: 'metadata.get_raw', arguments: { type: 'model', code: 'pf.demo.Model' } };
  const b = { arguments: { code: 'pf.demo.Model', type: 'model' }, toolAlias: 'metadata.get_raw', callId: 'call-1' };
  assert.equal(toolRequestDigest(a), toolRequestDigest(b));
  for (const changed of [{ ...a, callId: 'other' }, { ...a, toolAlias: 'metadata.get_meta' },
    { ...a, arguments: { ...a.arguments, code: 'pf.other.Model' } }]) assert.notEqual(toolRequestDigest(a), toolRequestDigest(changed));
});
