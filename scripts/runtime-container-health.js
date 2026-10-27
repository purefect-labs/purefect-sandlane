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
import { readSecret } from "../dist/common/env.js";
import { BrokerClient } from "../dist/sandbox/docker/client.js";

if (process.argv[2] === "broker") {
  const client = new BrokerClient(process.env.SANDLANE_BROKER_SOCKET, await readSecret(process.env, "SANDLANE_BROKER_SERVICE_TOKEN"));
  const status = await client.status(AbortSignal.timeout(3000));
  if (status.ready !== true) throw Error("Broker unavailable");
} else throw Error("Unknown health target");
