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
// Static declarations are shared by tools/list and the Worker config exporter.
export const tools = [
  {
    alias: "crm_customer",
    remoteName: "customer",
    description: "Read a customer from the configured service account's directory.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["id"],
      additionalProperties: false
    }
  }
];

// Replace with a real SDK client using this principal's service-account credentials.
// This fixture has no network calls, retry policy or real customer data.
export async function customerSdk(principal, args) {
  const name = principal.customers[args.id];
  return name === undefined
    ? {
        isError: true,
        structuredContent: { error: "NOT_FOUND" },
        content: [{ type: "text", text: "NOT_FOUND" }]
      }
    : { content: [{ type: "text", text: JSON.stringify({ id: args.id, name }) }] };
}
