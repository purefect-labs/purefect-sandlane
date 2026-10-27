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
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { boundedText } from "./validation.js";
import type {
  MemoryOperation,
  MemoryProvider,
  MemoryRecord,
  MemoryScope,
  MemorySource
} from "./contracts.js";
import type { ExplicitMemoryProvider } from "./contracts.js";

export function scopeKey(scope: MemoryScope): string {
  const parts = [scope.tenantId, scope.userId, scope.assignmentId ?? ""];
  if (
    parts.slice(0, 2).some(v => !v) ||
    parts.some(v => typeof v !== "string" || v.length > 128 || /[\x00-\x1f]/.test(v))
  )
    throw new Error("INVALID_MEMORY_SCOPE");
  return JSON.stringify(parts);
}

/** Single shared local database. Do not replicate this file independently across Host nodes.
 * Accepted writes commit synchronously; no background promises or extraction model are hidden here.
 */
export class SqliteMemoryStore implements ExplicitMemoryProvider {
  readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS memory_card (
        scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS memory_operation (
        scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(scope,request_id));`);
  }

  close(): void {
    this.database.close();
  }
  capabilities() {
    return {
      protocol: "memory/1" as const,
      search: ["keyword" as const],
      extensions: ["explicit-memory/1"]
    };
  }

  transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private change(
    scope: MemoryScope,
    requestId: string,
    payload: unknown,
    action: () => object
  ): MemoryOperation {
    boundedText(requestId, 128);
    const key = scopeKey(scope);
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return this.transaction(() => {
      const old = this.database
        .prepare("SELECT digest,result FROM memory_operation WHERE scope=? AND request_id=?")
        .get(key, requestId);
      if (old) {
        if (old.digest !== digest) throw new Error("MEMORY_REQUEST_CONFLICT");
        return JSON.parse(String(old.result)) as MemoryOperation;
      }
      const result = {
        operationId: requestId,
        state: "completed" as const,
        searchable: true,
        ...action()
      };
      // Only IDs/revisions/status are retained for replay. Deleted card bodies stay deleted.
      this.database
        .prepare("INSERT INTO memory_operation VALUES (?,?,?,?)")
        .run(key, requestId, digest, JSON.stringify(result));
      return result;
    });
  }

  async remember(request: {
    scope: MemoryScope;
    idempotencyKey: string;
    text: string;
    kind: MemoryRecord["kind"];
    source: MemorySource;
    signal: AbortSignal;
  }): Promise<MemoryOperation> {
    request.signal.throwIfAborted();
    boundedText(request.text, 500);
    if (!["preference", "fact", "experience"].includes(request.kind))
      throw new Error("MEMORY_KIND_INVALID");
    for (const value of [
      request.source?.conversationId,
      request.source?.runId,
      request.source?.messageId,
      request.source?.revision
    ])
      boundedText(value, 128);
    if (request.source.site !== undefined) boundedText(request.source.site, 128);
    boundedText(JSON.stringify(request.source), 1024);
    const key = scopeKey(request.scope);
    return this.change(
      request.scope,
      request.idempotencyKey,
      ["remember", request.text, request.kind, request.source],
      () => {
        this.capacity(key, request.text);
        const id = randomUUID();
        this.database
          .prepare("INSERT INTO memory_card VALUES (?,?,1,?,?,?,?)")
          .run(
            key,
            id,
            request.kind,
            request.text,
            JSON.stringify(request.source),
            new Date().toISOString()
          );
        return { recordId: id, revision: "1" };
      }
    );
  }

  private capacity(key: string, text: string, replacing?: string): void {
    const rows = this.database.prepare("SELECT id,text FROM memory_card WHERE scope=?").all(key);
    const remaining = rows.filter(row => row.id !== replacing);
    // Escaping control characters twice (card JSON inside CLI text JSON) also consumes budget.
    const encodedTexts = JSON.stringify(JSON.stringify([...remaining.map(row => row.text), text]));
    if (
      remaining.length >= 20 ||
      remaining.reduce(
        (n, row) => n + Buffer.byteLength(String(row.text)),
        Buffer.byteLength(text)
      ) > 4000 ||
      Buffer.byteLength(encodedTexts) > 8000
    )
      throw new Error("MEMORY_CAPACITY_REACHED");
  }

  list(scope: MemoryScope): readonly MemoryRecord[] {
    return this.database
      .prepare("SELECT * FROM memory_card WHERE scope=? ORDER BY id")
      .all(scopeKey(scope))
      .map(row => ({
        id: String(row.id),
        scope: { ...scope },
        revision: String(row.revision),
        kind: row.kind as MemoryRecord["kind"],
        text: String(row.text),
        sources: [JSON.parse(String(row.source)) as MemorySource],
        createdAt: String(row.created_at)
      }));
  }

  async search(request: Parameters<MemoryProvider["search"]>[0]): Promise<readonly MemoryRecord[]> {
    request.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      !Number.isSafeInteger(request.tokenBudget) ||
      request.tokenBudget < 1 ||
      request.tokenBudget > 8000
    )
      throw new Error("INVALID_MEMORY_SEARCH");
    boundedText(request.query, 20000);
    const matches = this.list(request.scope).filter(record =>
      record.text.toLowerCase().includes(request.query.toLowerCase())
    );
    let bytes = 0;
    return matches.slice(0, request.limit).filter(record => {
      bytes += Buffer.byteLength(record.text);
      return bytes <= request.tokenBudget;
    });
  }

  async ingest(_request: Parameters<MemoryProvider["ingest"]>[0]): Promise<MemoryOperation> {
    // Deliberate: ordinary conversation ingestion must never turn into implicit personal memory.
    throw new Error("MEMORY_EXPLICIT_WRITE_REQUIRED");
  }

  async correct(request: Parameters<MemoryProvider["correct"]>[0]): Promise<MemoryOperation> {
    request.signal.throwIfAborted();
    boundedText(request.id, 128);
    boundedText(request.expectedRevision, 128);
    boundedText(request.text, 500);
    const key = scopeKey(request.scope);
    return this.change(
      request.scope,
      request.idempotencyKey,
      ["correct", request.id, request.expectedRevision, request.text],
      () => {
        const row = this.database
          .prepare("SELECT revision FROM memory_card WHERE scope=? AND id=?")
          .get(key, request.id);
        if (!row || String(row.revision) !== request.expectedRevision)
          throw new Error("MEMORY_REVISION_CONFLICT");
        this.capacity(key, request.text, request.id);
        this.database
          .prepare("UPDATE memory_card SET text=?,revision=revision+1 WHERE scope=? AND id=?")
          .run(request.text, key, request.id);
        return { recordId: request.id, revision: String(Number(row.revision) + 1) };
      }
    );
  }

  async forget(request: Parameters<MemoryProvider["forget"]>[0]): Promise<MemoryOperation> {
    request.signal.throwIfAborted();
    boundedText(request.deletionVersion, 128);
    const key = scopeKey(request.scope);
    return this.change(
      request.scope,
      request.idempotencyKey,
      ["forget", request.selector, request.deletionVersion],
      () => {
        const selector = request.selector;
        if ("all" in selector && selector.all === true)
          this.database.prepare("DELETE FROM memory_card WHERE scope=?").run(key);
        else if ("ids" in selector && Array.isArray(selector.ids) && selector.ids.length <= 20) {
          for (const id of selector.ids)
            this.database.prepare("DELETE FROM memory_card WHERE scope=? AND id=?").run(key, id);
        } else if ("conversationId" in selector) {
          for (const card of this.list(request.scope))
            if (card.sources.some(source => source.conversationId === selector.conversationId))
              this.database
                .prepare("DELETE FROM memory_card WHERE scope=? AND id=?")
                .run(key, card.id);
        } else throw new Error("INVALID_MEMORY_SELECTOR");
        return { searchable: false };
      }
    );
  }

  async operation(request: Parameters<MemoryProvider["operation"]>[0]): Promise<MemoryOperation> {
    request.signal.throwIfAborted();
    const row = this.database
      .prepare("SELECT result FROM memory_operation WHERE scope=? AND request_id=?")
      .get(scopeKey(request.scope), request.operationId);
    if (!row) throw new Error("MEMORY_OPERATION_NOT_FOUND");
    return JSON.parse(String(row.result)) as MemoryOperation;
  }

  async export(request: Parameters<MemoryProvider["export"]>[0]) {
    request.signal.throwIfAborted();
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new Error("INVALID_MEMORY_EXPORT");
    const remaining = this.list(request.scope).filter(
      record => !request.cursor || record.id > request.cursor
    );
    const records = remaining.slice(0, request.limit);
    return {
      records,
      ...(remaining.length > records.length ? { nextCursor: records.at(-1)!.id } : {})
    };
  }
}
