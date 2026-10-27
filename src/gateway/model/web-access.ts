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
/** Per-Run web access rules shared by the model gateway's entry codecs. Web access is a
 * provider-executed web search tool; the gateway admits it as is (`open`), narrows its domain
 * filter to the Run's allowlist (`allowlist`) or removes it (`off`). Never widens a request. */
import { WEB_ACCESS_OFF, type WebAccessPolicy } from "../../spi/web-access.js";

export type { WebAccessPolicy };

/** Run web policy as seen by an entry codec. `functions`: client tools a Harness implements on
 * top of the provider's web search (e.g. a CLI's own search tool that issues the provider call);
 * they are offered only while the Run has web access. */
export interface WebPolicy {
  readonly access: WebAccessPolicy;
  readonly functions: readonly string[];
}

export const NO_WEB: WebPolicy = Object.freeze({
  access: WEB_ACCESS_OFF,
  functions: Object.freeze([])
});

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_DOMAINS = 100;

/** Validate a policy received from a Run lookup; anything malformed counts as no web access. */
export function webPolicyOf(access: unknown, functions: unknown): WebPolicy {
  const a = access as Partial<WebAccessPolicy> | undefined;
  const valid =
    !!a &&
    typeof a === "object" &&
    Array.isArray(a.domains) &&
    a.domains.length <= MAX_DOMAINS &&
    a.domains.every(domain => typeof domain === "string" && HOST.test(domain)) &&
    ((a.mode === "open" && a.domains.length === 0) ||
      (a.mode === "allowlist" && a.domains.length > 0) ||
      (a.mode === "off" && a.domains.length === 0));
  const names =
    Array.isArray(functions) &&
    functions.length <= 8 &&
    functions.every(
      name => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    )
      ? (functions as string[])
      : [];
  return Object.freeze({
    access: valid
      ? Object.freeze({ mode: a.mode!, domains: Object.freeze([...a.domains!]) })
      : WEB_ACCESS_OFF,
    functions: Object.freeze([...names])
  });
}

/** Host and optional path of a domain filter entry (`example.com`, `docs.example.com/api`),
 * lower-cased and without scheme; undefined when it is not a plain host name. */
function entry(raw: unknown): { host: string; path: string } | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const slash = value.indexOf("/");
  const host = slash === -1 ? value : value.slice(0, slash);
  const path = slash === -1 ? "" : value.slice(slash);
  if (!HOST.test(host) || host.length > 253 || /[\s?#]/.test(path)) return undefined;
  return { host, path };
}

/** `host` is `scope` or one of its subdomains. */
function within(host: string, scope: string): boolean {
  return host === scope || host.endsWith(`.${scope}`);
}

/** Domain filter for a request under an allowlist: without a requested filter, the allowlist;
 * otherwise their intersection (requested entries inside the allowlist, plus allowlist domains
 * inside a requested domain). Empty means the request can reach nothing. */
export function narrowDomains(requested: unknown, allowlist: readonly string[]): string[] {
  if (requested === undefined || requested === null) return [...allowlist];
  if (!Array.isArray(requested) || requested.length > MAX_DOMAINS) return [];
  if (!requested.length) return [...allowlist];
  const result = new Set<string>();
  for (const raw of requested) {
    const item = entry(raw);
    if (!item) continue;
    if (allowlist.some(scope => within(item.host, scope))) result.add(item.host + item.path);
    else if (!item.path)
      for (const scope of allowlist) if (within(scope, item.host)) result.add(scope);
  }
  return [...result].slice(0, MAX_DOMAINS);
}
