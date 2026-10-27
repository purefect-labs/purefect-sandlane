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
/** Activity summary of a provider-executed web search, shared by the Drivers. It names the
 * search (a clipped query, or the host of an opened page) and never carries results or page
 * contents. */

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const QUERY_LIMIT = 120;
/** Display title of the activity; clients may localize by `type` instead. */
export const WEB_SEARCH_TITLE = "联网搜索";

function clip(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > QUERY_LIMIT ? `${chars.slice(0, QUERY_LIMIT - 1).join("")}…` : text;
}

function host(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.hostname.length <= 253 ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

export interface WebSearchDetail {
  readonly query?: unknown;
  readonly url?: unknown;
}

/** `webSearch` activity item, or undefined for an unusable ID. */
export function webSearchActivity(
  id: unknown,
  status: "inProgress" | "completed" | "failed",
  detail: WebSearchDetail = {}
): Record<string, unknown> | undefined {
  if (typeof id !== "string" || !ID.test(id)) return undefined;
  const query = clip(detail.query);
  const domain = query ? undefined : host(detail.url);
  return {
    type: "webSearch",
    id,
    title: WEB_SEARCH_TITLE,
    status,
    ...(query ? { query } : {}),
    ...(domain ? { domain } : {})
  };
}
