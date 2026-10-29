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
import { randomBytes } from "node:crypto";
import { InMemoryControlPlane } from "../dist/plugins/standalone/control-plane.js";

const signal = () => new AbortController().signal;
const options = {
  harness: "claude-code",
  model: {
    base_uri: "https://model.example/v1",
    wire_api: "anthropic-messages",
    model: "demo",
    api_key: "upstream-secret"
  }
};
const request = () => ({
  runtime_id: "demo",
  lanes: ["demo"],
  claim_token: randomBytes(32).toString("base64url"),
  wait_ms: 0
});
async function claim(control, req = request()) {
  const raw = (await control.claim(req, signal()))[0];
  return { req, raw, ...control.readLease(raw, req.claim_token) };
}

test("demo claims are idempotent, isolated snapshots and bounded to one job", async () => {
  const control = new InMemoryControlPlane(options);
  control.submit("first");
  control.submit("second");
  const first = await claim(control);
  first.raw.run.input.prompt = "changed";
  const again = await control.claim(first.req, signal());
  assert.equal(again[0].run.input.prompt, "first");
  assert.equal(control.readLease(first.raw, first.req.claim_token), undefined);
  assert.equal((await claim(control)).lease.run.input.prompt, "second");
  assert.ok(!JSON.stringify(control.view("1")).includes("upstream-secret"));
  control.close();
});

test("demo events replay idempotently, reject gaps and conflicting content without partial commit", async () => {
  const control = new InMemoryControlPlane(options);
  control.submit("test");
  const { proof } = await claim(control);
  const event = { type: "assistant.message.delta", data: { text: "hello" } };
  assert.equal(
    (await control.sync({ ...proof, started: true, offset: 0, events: [event] }, signal()))
      .event_offset,
    1
  );
  assert.equal(
    (await control.sync({ ...proof, offset: 0, events: [event] }, signal())).event_offset,
    1
  );
  await assert.rejects(
    control.sync({ ...proof, offset: 2, events: [] }, signal()),
    e => e.fault === "event_offset_gap" && e.expected === 1
  );
  await assert.rejects(
    control.sync(
      { ...proof, offset: 0, events: [{ ...event, data: { text: "changed" } }] },
      signal()
    ),
    /invalid_input/
  );
  assert.equal(control.view("1").events.length, 1);
  control.close();
});

test("demo cancellation wins only before settlement and terminal retries keep their original outcome", async () => {
  const control = new InMemoryControlPlane(options);
  const id = control.submit("test"),
    { proof } = await claim(control);
  control.cancel(id);
  assert.equal((await control.sync(proof, signal())).cancel, true);
  const outcome = { status: "SUCCEEDED", answer: "done" };
  assert.equal(await control.complete({ ...proof, outcome }, signal()), "ACCEPTED_AS_CANCELLED");
  assert.equal(await control.complete({ ...proof, outcome }, signal()), "ALREADY_ACCEPTED");
  assert.equal(control.view(id).state, "CANCELLED");
  await assert.rejects(
    control.complete({ ...proof, outcome: { status: "FAILED" } }, signal()),
    /complete_rejected/
  );
  const second = control.submit("second"),
    next = await claim(control);
  await control.complete({ ...next.proof, outcome }, signal());
  control.cancel(second);
  assert.equal(control.view(second).state, "SUCCEEDED");
  control.close();
});

test("demo rejects old generations and expired proofs without requeueing", async () => {
  const control = new InMemoryControlPlane(options);
  const id = control.submit("test"),
    { proof } = await claim(control);
  await assert.rejects(control.sync({ ...proof, generation: 2 }, signal()), /lease_lost/);
  control.expire(id);
  await assert.rejects(control.sync(proof, signal()), /lease_lost/);
  await assert.rejects(
    control.complete({ ...proof, outcome: { status: "SUCCEEDED" } }, signal()),
    /lease_lost/
  );
  assert.equal(control.view(id).state, "FAILED");
  assert.deepEqual(await control.claim(request(), signal()), []);
  control.close();
});

test("demo queue, prompt and event limits reject explicitly; long polls abort", async () => {
  const control = new InMemoryControlPlane(options);
  assert.throws(() => control.submit("x".repeat(16385)), /PROMPT_LIMIT/);
  for (let i = 0; i < 16; i++) control.submit("test");
  assert.throws(() => control.submit("test"), /RUN_LIMIT/);
  const { proof } = await claim(control);
  await assert.rejects(
    control.sync(
      {
        ...proof,
        offset: 0,
        events: [{ type: "assistant.message.delta", data: { text: "x".repeat(16384) } }]
      },
      signal()
    ),
    /invalid_input/
  );
  assert.equal(control.view("1").events.length, 0);
  control.close();
  const empty = new InMemoryControlPlane(options);
  const abort = new AbortController();
  const polling = empty.claim({ ...request(), wait_ms: 25000 }, abort.signal);
  abort.abort();
  await assert.rejects(polling, { name: "AbortError" });
  const closing = empty.claim({ ...request(), wait_ms: 25000 }, signal());
  empty.close();
  await assert.rejects(closing, { name: "AbortError" });
});
