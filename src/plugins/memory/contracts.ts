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
/** Portable, optional memory boundary. These IDs come from the trusted caller, never the model. */
export interface MemoryScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly assignmentId?: string;
}

export interface MemorySource {
  readonly conversationId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly revision: string;
  readonly site?: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly revision: string;
  readonly kind: "preference" | "fact" | "experience";
  readonly text: string;
  readonly sources: readonly MemorySource[];
  readonly createdAt: string;
  readonly validUntil?: string;
  readonly supersedes?: string;
}

export interface MemoryRequest {
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

export interface MemoryOperation {
  readonly operationId: string;
  /** accepted is not a promise that the item is searchable or deletion is finished. */
  readonly state: "accepted" | "completed" | "failed";
  readonly errorCode?: string;
  readonly searchable?: boolean;
  readonly recordId?: string;
  readonly revision?: string;
}

/** Optional explicit-card extension; adapters may use local storage or a remote service. */
export interface ExplicitMemoryProvider extends MemoryProvider {
  list(scope: MemoryScope): readonly MemoryRecord[] | Promise<readonly MemoryRecord[]>;
  remember(
    request: MemoryRequest & {
      idempotencyKey: string;
      text: string;
      kind: MemoryRecord["kind"];
      source: MemorySource;
    }
  ): Promise<MemoryOperation>;
}

/** Implementations must enforce scope BEFORE retrieval, and persist accepted mutations.
 * Retries use the same idempotency key. Forget tombstones fence older queued writes.
 * Corrections use revision CAS; a conflict must not silently overwrite newer facts.
 * Provider-specific graph/temporal APIs belong in versioned extensions, not this contract.
 */
export interface MemoryProvider {
  capabilities(): Readonly<{
    protocol: "memory/1";
    search: readonly ("keyword" | "semantic" | "temporal")[];
    extensions: readonly string[];
  }>;
  search(
    request: MemoryRequest & {
      query: string;
      limit: number;
      tokenBudget: number;
    }
  ): Promise<readonly MemoryRecord[]>;
  ingest(
    request: MemoryRequest & {
      idempotencyKey: string;
      source: MemorySource;
      messages: readonly { role: "user" | "assistant"; text: string }[];
    }
  ): Promise<MemoryOperation>;
  correct(
    request: MemoryRequest & {
      id: string;
      expectedRevision: string;
      text: string;
      idempotencyKey: string;
    }
  ): Promise<MemoryOperation>;
  forget(
    request: MemoryRequest & {
      selector: { ids: readonly string[] } | { conversationId: string } | { all: true };
      deletionVersion: string;
      idempotencyKey: string;
    }
  ): Promise<MemoryOperation>;
  operation(request: MemoryRequest & { operationId: string }): Promise<MemoryOperation>;
  export(
    request: MemoryRequest & {
      cursor?: string;
      limit: number;
    }
  ): Promise<{ records: readonly MemoryRecord[]; nextCursor?: string }>;
}
