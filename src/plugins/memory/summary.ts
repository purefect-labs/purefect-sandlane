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
import { randomUUID } from "node:crypto";
import type { MemoryScope } from "./contracts.js";
import type { ConversationContext, ConversationTurn } from "../../common/conversation.js";
import { scopeKey, SqliteMemoryStore } from "./sqlite-store.js";
import { boundedText } from "./validation.js";

export interface ConversationSummary {
  text: string;
  throughRun: number;
  revision: number;
}
export interface SummaryInput {
  previous: string | null;
  turns: readonly ConversationTurn[];
}
export interface Summarizer {
  summarize(input: SummaryInput, signal: AbortSignal): Promise<string>;
}

interface Job {
  scope: string;
  conversation: string;
  token: string;
  revision: number;
  through: number;
  input: SummaryInput;
  attempts: number;
}

/** Durable queue and CAS in the same database as summaries; model calls never hold a DB transaction. */
export class ConversationSummaries {
  constructor(
    private readonly store: SqliteMemoryStore,
    private readonly clock = Date.now
  ) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS conversation_summary (
      scope TEXT NOT NULL, conversation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      through_run INTEGER NOT NULL DEFAULT 0, text TEXT, PRIMARY KEY(scope,conversation));
      CREATE TABLE IF NOT EXISTS summary_job (
      scope TEXT NOT NULL, conversation TEXT NOT NULL, revision INTEGER NOT NULL, through_run INTEGER NOT NULL,
      input TEXT NOT NULL, state TEXT NOT NULL, token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,conversation));`);
  }

  read(scope: MemoryScope, conversation: string): ConversationSummary | undefined {
    boundedText(conversation, 128);
    const row = this.store.database
      .prepare("SELECT * FROM conversation_summary WHERE scope=? AND conversation=?")
      .get(scopeKey(scope), conversation);
    return row?.text
      ? {
          text: String(row.text),
          throughRun: Number(row.through_run),
          revision: Number(row.revision)
        }
      : undefined;
  }

  enqueue(scope: MemoryScope, context: ConversationContext): "queued" | "not-needed" | "pending" {
    const key = scopeKey(scope);
    boundedText(context.conversationId, 128);
    return this.store.transaction(() => {
      const db = this.store.database;
      db.prepare("INSERT OR IGNORE INTO conversation_summary(scope,conversation) VALUES (?,?)").run(
        key,
        context.conversationId
      );
      const existing = this.read(scope, context.conversationId);
      const revision =
        existing?.revision ??
        Number(
          db
            .prepare("SELECT revision FROM conversation_summary WHERE scope=? AND conversation=?")
            .get(key, context.conversationId)!.revision
        );
      const after = existing?.throughRun ?? 0;
      const pending = db
        .prepare("SELECT state FROM summary_job WHERE scope=? AND conversation=?")
        .get(key, context.conversationId);
      if (pending && pending.state !== "failed") return "pending";
      // Failed jobs stay failed until an explicit retry/reset; don't create an endless paid loop.
      if (pending) return "pending";
      const remaining = context.turns.filter(turn => turn.run > after);
      if (remaining.length < 8) return "not-needed";
      const turns = remaining.slice(0, -4);
      let expected = after + 1;
      for (const turn of turns) {
        if (turn.run !== expected++ || turn.truncated) throw new Error("SUMMARY_HISTORY_GAP");
      }
      const input: SummaryInput = { previous: existing?.text ?? null, turns };
      boundedText(JSON.stringify(input), 64000);
      db.prepare(
        "INSERT INTO summary_job(scope,conversation,revision,through_run,input,state) VALUES (?,?,?,?,?,'pending')"
      ).run(key, context.conversationId, revision, turns.at(-1)!.run, JSON.stringify(input));
      return "queued";
    });
  }

  private claim(): Job | undefined {
    return this.store.transaction(() => {
      const db = this.store.database;
      const now = this.clock();
      db.prepare(
        "UPDATE summary_job SET state='failed',input='' WHERE attempts>=3 AND lease_until<=?"
      ).run(now);
      const row = db
        .prepare(
          `SELECT * FROM summary_job WHERE attempts<3 AND next_at<=?
        AND (state='pending' OR (state='running' AND lease_until<=?)) ORDER BY next_at LIMIT 1`
        )
        .get(now, now);
      if (!row) return undefined;
      const token = randomUUID();
      db.prepare(
        "UPDATE summary_job SET state='running',token=?,lease_until=?,attempts=attempts+1 WHERE scope=? AND conversation=?"
      ).run(token, now + 120000, String(row.scope), String(row.conversation));
      return {
        scope: String(row.scope),
        conversation: String(row.conversation),
        token,
        revision: Number(row.revision),
        through: Number(row.through_run),
        input: JSON.parse(String(row.input)),
        attempts: Number(row.attempts) + 1
      };
    });
  }

  async tick(model: Summarizer, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const job = this.claim();
    if (!job) return false;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("SUMMARY_CANCELLED"));
        deadline.addEventListener("abort", onAbort, { once: true });
        if (deadline.aborted) onAbort();
      });
      const text = await Promise.race([model.summarize(job.input, deadline), interrupted]);
      signal.throwIfAborted();
      boundedText(text, 8000);
      this.store.transaction(() => {
        const db = this.store.database;
        const owned = db
          .prepare("SELECT token,lease_until FROM summary_job WHERE scope=? AND conversation=?")
          .get(job.scope, job.conversation);
        if (owned?.token !== job.token || Number(owned.lease_until) <= this.clock()) return;
        db.prepare(
          `UPDATE conversation_summary SET revision=revision+1,through_run=?,text=?
          WHERE scope=? AND conversation=? AND revision=?`
        ).run(job.through, text, job.scope, job.conversation, job.revision);
        // A stale/delete-fenced result is discarded, not rebased onto newer content.
        db.prepare("DELETE FROM summary_job WHERE scope=? AND conversation=? AND token=?").run(
          job.scope,
          job.conversation,
          job.token
        );
      });
    } catch {
      this.store.database
        .prepare(
          `UPDATE summary_job SET state=?,input=CASE WHEN ?>=3 THEN '' ELSE input END,
        token=NULL,lease_until=0,next_at=? WHERE scope=? AND conversation=? AND token=?`
        )
        .run(
          job.attempts >= 3 ? "failed" : "pending",
          job.attempts,
          this.clock() + 30000 * 2 ** (job.attempts - 1),
          job.scope,
          job.conversation,
          job.token
        );
      signal.throwIfAborted();
    } finally {
      if (onAbort) deadline.removeEventListener("abort", onAbort);
    }
    return true;
  }

  status(scope: MemoryScope, conversation: string): string {
    return String(
      this.store.database
        .prepare("SELECT state FROM summary_job WHERE scope=? AND conversation=?")
        .get(scopeKey(scope), conversation)?.state ?? "idle"
    );
  }

  /** Explicit reset also fences in-flight model work. Original conversation records are not deleted. */
  reset(scope: MemoryScope, conversation: string): void {
    this.store.transaction(() => {
      const key = scopeKey(scope);
      this.store.database
        .prepare(
          `INSERT INTO conversation_summary(scope,conversation,revision) VALUES (?,?,1)
        ON CONFLICT(scope,conversation) DO UPDATE SET revision=revision+1,through_run=0,text=NULL`
        )
        .run(key, conversation);
      this.store.database
        .prepare("DELETE FROM summary_job WHERE scope=? AND conversation=?")
        .run(key, conversation);
    });
  }
}
