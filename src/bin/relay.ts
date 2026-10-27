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
import { GatewayRelay } from "../network/gateway-relay.js";

/** Dedicated infrastructure container. No CLI, provider keys or Run credentials. */
async function main(): Promise<void> {
  const raw = process.env.SANDLANE_RELAY_ROUTES ?? "";
  if (Buffer.byteLength(raw) > 4096) throw new Error("RELAY_CONFIGURATION_LIMIT");
  const routes: unknown = JSON.parse(raw);
  if (
    !Array.isArray(routes) ||
    routes.some(
      r =>
        !r ||
        typeof r !== "object" ||
        Object.keys(r).length !== 4 ||
        !["listenHost", "listenPort", "upstreamHost", "upstreamPort"].every(k =>
          Object.hasOwn(r, k)
        )
    )
  )
    throw new Error("RELAY_CONFIGURATION_INVALID");
  const relay = new GatewayRelay(routes);
  await relay.start();
  const stop = () => {
    void relay.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => {
  console.error("SANDLANE_RELAY_UNAVAILABLE");
  process.exitCode = 1;
});
