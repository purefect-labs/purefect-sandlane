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
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type {
  RunClientAction,
  RunConfirmation,
  RunControlTool,
  RunCredentialLookup,
  RunCredentialView,
  RunGrant
} from "../spi/run-credentials.js";
import { WEB_ACCESS_OFF } from "../spi/web-access.js";

export type { RunGrant };

export interface RunSecrets {
  readonly modelKey: string;
  readonly agentToken: Readonly<{ value: string; expiresAt: number }>;
  readonly leaseUntil: number;
}

const capability = () => randomBytes(32).toString("base64url");

/** Runtime-memory credentials of one Run. Secrets live in private fields, so neither
 * JSON.stringify nor util.inspect can expose them; only capabilities enter the sandbox. */
export class RunCredential implements RunCredentialView {
  readonly id = randomUUID();
  readonly grant: RunGrant;
  readonly clientAction?: RunClientAction;
  readonly confirmation?: RunConfirmation;
  readonly controlTools: readonly RunControlTool[];
  readonly #modelCapability: string;
  readonly #toolCapability: string;
  #modelKey: string | undefined;
  #agentToken: { value: string; expiresAt: number } | undefined;
  #leaseUntil: number;
  #revoked = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #webSearches = 0;
  readonly #abort = new AbortController();
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    grant: RunGrant,
    secrets: RunSecrets,
    clientAction?: RunClientAction,
    confirmation?: RunConfirmation,
    controlTools: readonly RunControlTool[] = []
  ) {
    this.controlTools = Object.freeze(
      controlTools.map(tool =>
        Object.freeze({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          call: tool.call
        })
      )
    );
    if (confirmation?.operations.length)
      this.confirmation = Object.freeze({
        operations: Object.freeze([...confirmation.operations]),
        confirm: confirmation.confirm
      });
    if (clientAction)
      this.clientAction = Object.freeze({
        name: clientAction.name,
        description: clientAction.description,
        inputSchema: clientAction.inputSchema,
        call: clientAction.call
      });
    this.grant = Object.freeze({
      ...grant,
      runtime: Object.freeze({ ...grant.runtime }),
      enabledTools: Object.freeze([...grant.enabledTools]),
      // A grant without a policy never reaches the web.
      webAccess: grant.webAccess
        ? Object.freeze({
            mode: grant.webAccess.mode,
            domains: Object.freeze([...grant.webAccess.domains])
          })
        : WEB_ACCESS_OFF
    });
    const model = capability();
    let tool = capability();
    while (tool === model) tool = capability();
    this.#modelCapability = model;
    this.#toolCapability = tool;
    this.#modelKey = secrets.modelKey;
    this.#agentToken = { ...secrets.agentToken };
    this.#leaseUntil = secrets.leaseUntil;
    this.#arm();
  }

  /** Aborted on revocation or when the lease passes without renewal (Engine unreachable). */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  get revoked(): boolean {
    return this.#revoked;
  }
  get leaseUntil(): number {
    return this.#leaseUntil;
  }
  get usage(): { input_tokens: number; output_tokens: number } {
    return { input_tokens: this.#inputTokens, output_tokens: this.#outputTokens };
  }
  /** Provider-executed web searches reported by the upstream (diagnostics; not in the outcome). */
  get webSearches(): number {
    return this.#webSearches;
  }
  /** Scoped capabilities for the sandbox launch only. */
  capabilities(): { model: string; tool: string } {
    return { model: this.#modelCapability, tool: this.#toolCapability };
  }
  matchesModel(value: string): boolean {
    return !this.#revoked && value === this.#modelCapability;
  }
  matchesTool(value: string): boolean {
    return !this.#revoked && value === this.#toolCapability;
  }

  modelUsable(now = Date.now()): boolean {
    return !this.#revoked && !this.#abort.signal.aborted && this.#leaseUntil > now;
  }
  toolUsable(now = Date.now()): boolean {
    return this.modelUsable(now) && !!this.#agentToken && this.#agentToken.expiresAt > now;
  }
  /** Upstream model key, only while the Run holds a live lease. */
  modelKey(now = Date.now()): string | undefined {
    return this.modelUsable(now) ? this.#modelKey : undefined;
  }
  /** Current short-lived control plane token of the Run owner, only while unexpired. */
  agentToken(now = Date.now()): Readonly<{ value: string; expiresAt: number }> | undefined {
    return this.toolUsable(now) ? Object.freeze({ ...this.#agentToken! }) : undefined;
  }

  /**
   * Every successful sync renews the lease and replaces the token. Without a token (the Run
   * subject lost access) the current one is dropped at once instead of lingering to expiry.
   */
  renew(leaseUntil: number, agentToken?: Readonly<{ value: string; expiresAt: number }>): void {
    if (this.#revoked || this.#abort.signal.aborted) return;
    if (Number.isSafeInteger(leaseUntil) && leaseUntil > 0) this.#leaseUntil = leaseUntil;
    if (agentToken === undefined) this.#agentToken = undefined;
    else if (
      typeof agentToken?.value === "string" &&
      agentToken.value &&
      Number.isSafeInteger(agentToken.expiresAt)
    )
      this.#agentToken = { value: agentToken.value, expiresAt: agentToken.expiresAt };
    this.#arm();
  }

  addUsage(
    inputTokens: number | null,
    outputTokens: number | null,
    webSearches: number | null = null
  ): void {
    if (Number.isSafeInteger(inputTokens) && Number(inputTokens) > 0)
      this.#inputTokens += Number(inputTokens);
    if (Number.isSafeInteger(outputTokens) && Number(outputTokens) > 0)
      this.#outputTokens += Number(outputTokens);
    if (Number.isSafeInteger(webSearches) && Number(webSearches) > 0)
      this.#webSearches += Number(webSearches);
  }

  /** Clears secrets and aborts in-flight downstream requests. Usage remains readable. */
  revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#modelKey = undefined;
    this.#agentToken = undefined;
    clearTimeout(this.#leaseTimer);
    this.#abort.abort();
  }

  #arm(): void {
    clearTimeout(this.#leaseTimer);
    const remaining = this.#leaseUntil - Date.now();
    if (remaining <= 0) {
      this.#abort.abort();
      return;
    }
    // Node timers are limited to ~24.8 days; leases are seconds.
    this.#leaseTimer = setTimeout(() => this.#arm(), Math.min(remaining, 2 ** 31 - 1));
    this.#leaseTimer.unref?.();
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, grant: this.grant, revoked: this.#revoked };
  }
  [inspect.custom](): string {
    return `RunCredential(${this.id}, run=${this.grant.runId}, revoked=${this.#revoked})`;
  }
}

/** Capability -> Run lookup for the in-process gateways. No persistence, no cross-run cache. */
export class RunCredentialRegistry implements RunCredentialLookup {
  readonly #byModel = new Map<string, RunCredential>();
  readonly #byTool = new Map<string, RunCredential>();
  readonly #byId = new Map<string, RunCredential>();

  register(
    grant: RunGrant,
    secrets: RunSecrets,
    clientAction?: RunClientAction,
    confirmation?: RunConfirmation,
    controlTools?: readonly RunControlTool[]
  ): RunCredential {
    const credential = new RunCredential(grant, secrets, clientAction, confirmation, controlTools);
    const { model, tool } = credential.capabilities();
    this.#byModel.set(model, credential);
    this.#byTool.set(tool, credential);
    this.#byId.set(credential.id, credential);
    return credential;
  }
  byModelCapability(value: string): RunCredential | undefined {
    const credential = this.#byModel.get(value);
    return credential?.matchesModel(value) ? credential : undefined;
  }
  byToolCapability(value: string): RunCredential | undefined {
    const credential = this.#byTool.get(value);
    return credential?.matchesTool(value) ? credential : undefined;
  }
  byId(id: string): RunCredential | undefined {
    const credential = this.#byId.get(id);
    return credential && !credential.revoked ? credential : undefined;
  }
  get size(): number {
    return this.#byId.size;
  }
  revoke(credential: RunCredential): void {
    credential.revoke();
    const { model, tool } = credential.capabilities();
    if (this.#byModel.get(model) === credential) this.#byModel.delete(model);
    if (this.#byTool.get(tool) === credential) this.#byTool.delete(tool);
    if (this.#byId.get(credential.id) === credential) this.#byId.delete(credential.id);
  }
}
