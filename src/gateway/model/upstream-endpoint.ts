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

/** Resolve an operator/control-plane supplied base or complete endpoint. Never use CLI input.
 * Root URLs retain the historical /v1 default. Explicit endpoints avoid provider-specific
 * version guesses; all other prefixes are preserved. This is not a network destination allowlist. */
export function upstreamEndpoint(base: string, wire: "responses" | "anthropic-messages"): string {
  try {
    if (
      typeof base !== "string" ||
      base.length > 2048 ||
      !base.startsWith("https://") ||
      /[\s\\%?#]/.test(base)
    )
      throw Error();
    const url = new URL(base);
    const rawPath = base.slice("https://".length).replace(/^[^/]+/, "") || "/";
    if (
      url.username ||
      url.password ||
      !url.hostname ||
      rawPath.includes("//") ||
      rawPath.split("/").some(part => part === "." || part === "..") ||
      !/^\/[A-Za-z0-9_./~-]*$/.test(rawPath)
    )
      throw Error();
    const path = url.pathname.replace(/\/$/, "");
    const resource = wire === "responses" ? "responses" : "messages";
    if (/\/(responses|messages|chat\/completions)$/.test(path)) {
      if (!path.endsWith("/" + resource)) throw Error();
      url.pathname = path;
    } else if (!path) {
      url.pathname = "/v1/" + resource;
    } else {
      url.pathname =
        path +
        (wire === "anthropic-messages" && !/\/v[0-9]+$/.test(path) ? "/v1/" : "/") +
        resource;
    }
    return url.href;
  } catch {
    // Never reflect a potentially credential-bearing configuration in diagnostics.
    throw new Error("MODEL_PROVIDER_CONFIGURATION");
  }
}
