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
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { createManagedRuntime } from "../runtime/managed.js";
import { FrozenInputContext } from "../core/turn-input.js";
import { InMemoryControlPlane } from "../plugins/standalone/control-plane.js";
import { demoTools } from "../plugins/standalone/tools.js";
import { createDemoModel } from "../plugins/standalone/model-fixture.js";
import { readSecret } from "../common/env.js";
import type { ModelService } from "../spi/control-plane.js";
import { BUILTIN_HARNESS_METADATA, isBuiltinHarness } from "../common/builtin-harness.js";

async function main() {
  const config = JSON.parse(await readFile("/demo/config.json", "utf8"));
  if (
    !["fixture", "real"].includes(config.mode) ||
    !["success", "cancel", "lease-loss"].includes(config.scenario)
  )
    throw new Error("INVALID_DEMO_MODE");
  const key = await readFile("/demo/gateway-key.pem"),
    cert = await readFile("/demo/gateway.pem");
  const apiKey =
    config.mode === "fixture"
      ? randomBytes(32).toString("hex")
      : await readSecret({ DEMO_KEY_FILE: "/demo/model-key" }, "DEMO_KEY");
  const fixture =
    config.mode === "fixture"
      ? createDemoModel({ key, cert }, apiKey, config.messagesAuth)
      : undefined;
  const harness: unknown = config.harness;
  if (typeof harness !== "string" || !isBuiltinHarness(harness))
    throw new Error("INVALID_DEMO_HARNESS");
  const model: ModelService = {
    base_uri: fixture ? "https://127.0.0.1:19446/v1" : config.modelOrigin,
    wire_api: BUILTIN_HARNESS_METADATA[harness].wire,
    model: fixture ? "demo" : config.model,
    api_key: apiKey
  };
  const control = new InMemoryControlPlane({
    model,
    harness: config.harness,
    deadlineMs: config.mode === "fixture" ? 60_000 : 600_000
  });
  const id = control.submit(
    config.prompt ?? "Call demo_echo with the nonce requested by the model."
  );
  let calls = 0,
    ended = false;
  let actionTimer: ReturnType<typeof setTimeout> | undefined;
  const tools = demoTools(nonce => {
    calls++;
    if (fixture && nonce !== fixture.evidence().nonce) throw new Error("DEMO_NONCE_MISMATCH");
    if (calls === 1 && config.scenario !== "success")
      actionTimer = setTimeout(() => {
        if (config.scenario === "cancel") control.cancel(id);
        else control.expire(id);
      }, 100);
  });
  const runtime = await createManagedRuntime({
    controlPlane: control,
    broker: {
      socket: "/control/broker.sock",
      token: (await readFile("/demo/broker-token", "utf8")).trim(),
      nodeId: config.nodeId
    },
    concurrency: 1,
    harnesses: [config.harness],
    model: { messagesAuth: config.messagesAuth ?? "x-api-key" },
    lane: {
      runtimeId: "standalone-demo",
      lanes: ["demo"],
      context: new FrozenInputContext(),
      claimWaitMs: 1000
    },
    tools: {
      provider: tools,
      serverId: "demo",
      targetRef: "demo",
      targetVersion: 1,
      enabled: ["demo_echo"]
    },
    gateways: {
      model: { bind: "0.0.0.0", port: 19443, hostname: "model.demo.test", tls: { key, cert } },
      tool: { bind: "0.0.0.0", port: 19444, hostname: "tools.demo.test", tls: { key, cert } }
    },
    endpoints: fixture ? [{ server: fixture.server, bind: "127.0.0.1", port: 19446 }] : [],
    onTiming: (runId, phase, elapsedMs) => {
      console.log(JSON.stringify({ type: "demo.driver-timing", run: runId, phase, elapsedMs }));
    },
    observeLane: () => event => {
      if (event.type === "run.ended") ended = true;
      if (event.type !== "lane") console.log(JSON.stringify({ type: "demo.progress", event }));
    }
  });
  let runtimeError: unknown;
  void runtime.done.catch(error => {
    runtimeError = error;
  });
  const stop = () => control.cancel(id);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let offset = 0;
  try {
    const until = Date.now() + (config.mode === "fixture" ? 90_000 : 660_000);
    while (!ended) {
      if (runtimeError) throw runtimeError;
      if (Date.now() > until) throw new Error("DEMO_TIMEOUT");
      const view = control.view(id);
      for (const event of view.events.slice(offset))
        console.log(JSON.stringify({ type: "demo.event", event: event.type }));
      offset = view.events.length;
      await delay(50);
    }
    const view = control.view(id);
    const expected = { success: "SUCCEEDED", cancel: "CANCELLED", "lease-loss": "FAILED" }[
      config.scenario as "success" | "cancel" | "lease-loss"
    ];
    if (view.state !== expected) throw new Error("DEMO_UNEXPECTED_OUTCOME");
    if (
      fixture &&
      (calls !== 1 ||
        fixture.evidence().requests < 1 ||
        (config.scenario === "success" &&
          (!fixture.evidence().verified ||
            !view.outcome?.answer?.includes(fixture.evidence().nonce))))
    )
      throw new Error("DEMO_EVIDENCE_MISSING");
    console.log(
      JSON.stringify({
        type: "demo.result",
        mode: config.mode,
        scenario: config.scenario,
        state: view.state,
        toolCalls: calls,
        modelRequests: fixture?.evidence().requests,
        usage: view.outcome?.usage,
        answer: view.outcome?.answer
      })
    );
  } finally {
    clearTimeout(actionTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Do not report cleanup success if an adapter ignores cancellation.
    const watchdog = setTimeout(() => {
      console.error("DEMO_CLEANUP_INCOMPLETE");
      process.exit(1);
    }, 45_000);
    try {
      await runtime.close();
    } finally {
      clearTimeout(watchdog);
      control.close();
    }
  }
}
main().catch(() => {
  console.error("DEMO_FAILED: inspect progress and configuration");
  process.exitCode = 1;
});
