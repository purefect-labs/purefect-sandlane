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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { verifyRelay } from "../dist/sandbox/docker/relay-binding.js";

const [command, ...args] = process.argv.slice(2);
if (command === "routes") {
  const [host, model = "19443", tool = "19444"] = args;
  if (
    !isIP(host ?? "") ||
    ![model, tool].every(p => /^[0-9]+$/.test(p) && Number(p) > 0 && Number(p) <= 65535)
  )
    throw Error("Usage: relay-binding.js routes <fixed-worker-ip> [model-port] [tool-port]");
  const routes = JSON.stringify(
    [model, tool].map(port => ({
      listenHost: "0.0.0.0",
      listenPort: Number(port),
      upstreamHost: host,
      upstreamPort: Number(port)
    }))
  );
  console.log("SANDLANE_RELAY_ROUTES=" + routes);
  console.log("SANDLANE_RELAY_POLICY_DIGEST=" + createHash("sha256").update(routes).digest("hex"));
} else if (command === "inspect") {
  const [id, nodeId = "local-docker-1", prefix = "cn.purefect.sandlane"] = args;
  if (!/^[a-f0-9]{64}$/.test(id ?? ""))
    throw Error("Provide the full immutable Relay container ID");
  const info = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }))[0];
  const routes = info.Config.Env.find(value => value.startsWith("SANDLANE_RELAY_ROUTES="))?.slice(
    "SANDLANE_RELAY_ROUTES=".length
  );
  if (!routes) throw Error("Relay routes missing");
  const binding = {
    containerId: info.Id,
    imageId: info.Image,
    policyDigest: createHash("sha256").update(routes).digest("hex")
  };
  // Apply the Broker's actual confinement verifier before emitting the operator binding.
  await verifyRelay({ request: async () => info }, nodeId, prefix, binding);
  console.log("SANDLANE_BROKER_RELAY_BINDING=" + JSON.stringify(binding));
} else throw Error("Usage: relay-binding.js routes|inspect ...");
