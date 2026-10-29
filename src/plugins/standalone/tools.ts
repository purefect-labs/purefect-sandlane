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
import { ToolGatewayError, type ToolProvider } from "../../spi/tool-provider.js";

/** A deliberately side-effect-free tool: the downstream adapter validates parameters and identity. */
export function demoTools(onCall?: (nonce: string) => void): ToolProvider {
  const validate = (args: Readonly<Record<string, unknown>>) => {
    if (
      Object.keys(args).length !== 1 ||
      typeof args.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(args.nonce)
    )
      throw new ToolGatewayError("INVALID_TOOL_ARGUMENTS");
  };
  return {
    tools: [
      {
        alias: "demo_echo",
        version: 1,
        readOnly: true,
        description: "Return the supplied demo nonce without accessing external services.",
        inputSchema: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false
        },
        validateParams: validate
      }
    ],
    validate(input) {
      if (input.toolAlias !== "demo_echo") throw new ToolGatewayError("UNKNOWN_TOOL");
      validate(input.arguments);
    },
    async invoke(input, identity, _token, signal) {
      signal.throwIfAborted();
      if (identity.tenantId !== "demo" || identity.userId !== "demo")
        throw new ToolGatewayError("DEMO_IDENTITY_REJECTED");
      const nonce = String(input.arguments.nonce);
      onCall?.(nonce);
      return { nonce };
    }
  };
}
