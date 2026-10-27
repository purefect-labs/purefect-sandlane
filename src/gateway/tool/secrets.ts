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
import { ToolGatewayError, type ToolPermit, type ToolSecrets } from "./gateway.js";

/** Trusted backend response, never a generic datastore row supplied by the caller.
 * Vault/field readers must verify these fields against the actual authorization binding and row,
 * not copy them from the request. No plaintext-returning public endpoint may expose this port. */
export interface UserCredential {
  tenantId: string; userId: string; serverId: string; bindingVersion: number;
  ownerTenantAccessId: string;
  /** Material revision, not Vault encryption key_version. Must come from the actual source. */
  credentialVersion: number;
  active: boolean; accessToken: string; expiresAt: number;
}
export interface UserCredentialSources {
  /** Read one explicit Vault entry under exact tenant routing; enforce user ownership binding. */
  vault(input: { permit: ToolPermit; code: string }, signal: AbortSignal): Promise<UserCredential>;
  /** Require encrypted field and exact tenant/owner row, no org/tenant fallback. Never accept a
   * credential_row from Harness input. Agent-token exchange belongs in this trusted backend. */
  field(input: { permit: ToolPermit; model: string; field: string; row: string }, signal: AbortSignal): Promise<UserCredential>;
}
/** Explicit source routing, no CompositeConnectorCredentialResolver/environment fallback.
 * Does not substitute for source-side authorization or authority.dispatch's final live check. */
export class BoundUserToolSecrets implements ToolSecrets {
  constructor(private readonly sources: UserCredentialSources) {}
  async read(permit: ToolPermit, signal: AbortSignal): Promise<{ accessToken: string; expiresAt: number }> {
    signal.throwIfAborted();
    // The Gateway supplies a frozen permit. Copy again for safe direct service-side use.
    const p = Object.freeze({ ...permit });
    if (p.userId !== p.subjectUserId || typeof p.actorTenantAccessId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(p.actorTenantAccessId) ||
        !Number.isSafeInteger(p.credentialVersion) || p.credentialVersion < 1 ||
        p.actorTenantAccessId !== p.credentialOwnerTenantAccessId) throw new ToolGatewayError("TOOL_CREDENTIAL_UNAVAILABLE");
    const vault = p.credentialRef.match(/^\$\{secret:\/\/vault::([A-Za-z0-9][A-Za-z0-9_./-]{0,255})\}$/);
    const field = p.credentialRef.match(/^\$\{secret:\/\/field::([A-Za-z0-9][A-Za-z0-9_.:-]{0,255})#([A-Za-z0-9_]{1,128})\}$/);
    let value: UserCredential;
    if (vault && p.credentialRow === null) value = await this.sources.vault({ permit: p, code: vault[1]! }, signal);
    else if (field && typeof p.credentialRow === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(p.credentialRow)) {
      value = await this.sources.field({ permit: p, model: field[1]!, field: field[2]!, row: p.credentialRow }, signal);
    } else throw new ToolGatewayError("TOOL_CREDENTIAL_UNAVAILABLE");
    signal.throwIfAborted();
    if (!value || value.active !== true || value.tenantId !== p.tenantId || value.userId !== p.userId ||
        value.ownerTenantAccessId !== p.actorTenantAccessId ||
        value.serverId !== p.serverId || value.bindingVersion !== p.bindingVersion ||
        value.credentialVersion !== p.credentialVersion ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || p.expiresAt <= Date.now() ||
        typeof value.accessToken !== "string" || !/^[\x21-\x7e]{32,8192}$/.test(value.accessToken)) {
      throw new ToolGatewayError("TOOL_CREDENTIAL_UNAVAILABLE");
    }
    return { accessToken: value.accessToken, expiresAt: Math.min(value.expiresAt, p.expiresAt) };
  }
}
