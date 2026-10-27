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
import type { MemoryProvider, MemoryRecord, MemoryScope } from "./contracts.js";

/** Optional, scoped access for context builders. No provider means no I/O or timers.
 * Mutation delivery belongs to the caller's durable outbox, not an in-process background queue.
 */
export class MemoryClient {
  readonly scope: MemoryScope;

  constructor(
    scope: MemoryScope,
    private readonly provider?: MemoryProvider
  ) {
    for (const id of [
      scope.tenantId,
      scope.userId,
      ...(scope.assignmentId === undefined ? [] : [scope.assignmentId])
    ]) {
      if (typeof id !== "string" || !/^[A-Za-z0-9_:-]{1,128}$/.test(id))
        throw new Error("INVALID_MEMORY_SCOPE");
    }
    this.scope = Object.freeze({
      tenantId: scope.tenantId,
      userId: scope.userId,
      ...(scope.assignmentId === undefined ? {} : { assignmentId: scope.assignmentId })
    });
    if (provider && provider.capabilities().protocol !== "memory/1")
      throw new Error("UNSUPPORTED_MEMORY_PROVIDER");
  }

  async search(
    query: string,
    options: {
      signal: AbortSignal;
      timeoutMs?: number;
      limit?: number;
      tokenBudget?: number;
    }
  ): Promise<{
    status: "disabled" | "available" | "unavailable";
    records: readonly MemoryRecord[];
  }> {
    options.signal.throwIfAborted();
    if (!this.provider) return { status: "disabled", records: [] };
    const timeoutMs = options.timeoutMs ?? 200;
    const limit = options.limit ?? 5;
    const tokenBudget = options.tokenBudget ?? 1000;
    if (
      !query.trim() ||
      Buffer.byteLength(query) > 20000 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(tokenBudget) ||
      tokenBudget < 1 ||
      tokenBudget > 8000
    )
      throw new Error("INVALID_MEMORY_SEARCH");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        stopped = () => reject(new Error("MEMORY_UNAVAILABLE"));
        controller.signal.addEventListener("abort", stopped, { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
      });
      const records = await Promise.race([
        this.provider.search({
          scope: this.scope,
          query,
          limit,
          tokenBudget,
          signal: controller.signal
        }),
        deadline
      ]);
      // Defense against a misconfigured provider. This is not a substitute for scoped retrieval.
      if (
        !Array.isArray(records) ||
        records.length > limit ||
        records.some(
          record =>
            !record?.scope ||
            record.scope.tenantId !== this.scope.tenantId ||
            record.scope.userId !== this.scope.userId ||
            record.scope.assignmentId !== this.scope.assignmentId ||
            typeof record.text !== "string"
        ) ||
        records.reduce((size, record) => size + Buffer.byteLength(record.text), 0) > tokenBudget
      )
        throw new Error("MEMORY_PROVIDER_CONTRACT_VIOLATION");
      // Bytes are a conservative token upper bound for supported byte-based model tokenizers.
      return { status: "available", records };
    } catch {
      options.signal.throwIfAborted();
      return { status: "unavailable", records: [] };
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (stopped) controller.signal.removeEventListener("abort", stopped);
    }
  }

  /** For durable outbox consumers and management APIs. Scope cannot be supplied by model arguments. */
  mutations() {
    if (!this.provider) throw new Error("MEMORY_DISABLED");
    const provider = this.provider;
    const scoped = <T extends object>(request: T) => ({ ...request, scope: this.scope });
    return {
      ingest: (request: Omit<Parameters<MemoryProvider["ingest"]>[0], "scope">) =>
        provider.ingest(scoped(request)),
      correct: (request: Omit<Parameters<MemoryProvider["correct"]>[0], "scope">) =>
        provider.correct(scoped(request)),
      forget: (request: Omit<Parameters<MemoryProvider["forget"]>[0], "scope">) =>
        provider.forget(scoped(request)),
      operation: (request: Omit<Parameters<MemoryProvider["operation"]>[0], "scope">) =>
        provider.operation(scoped(request)),
      export: async (request: Omit<Parameters<MemoryProvider["export"]>[0], "scope">) => {
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
          throw new Error("INVALID_MEMORY_EXPORT");
        const page = await provider.export(scoped(request));
        if (
          !Array.isArray(page.records) ||
          page.records.length > request.limit ||
          page.records.some(
            record =>
              !record?.scope ||
              record.scope.tenantId !== this.scope.tenantId ||
              record.scope.userId !== this.scope.userId ||
              record.scope.assignmentId !== this.scope.assignmentId
          )
        )
          throw new Error("MEMORY_PROVIDER_CONTRACT_VIOLATION");
        return page;
      }
    };
  }
}
