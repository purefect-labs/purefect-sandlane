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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import { readSecret, type Env } from "../common/env.js";
import { statusPage } from "./page.js";
import type { RunIdMode, StatusRecorder, StatusSnapshot } from "./recorder.js";

export interface StatusPanelConfig {
  readonly bind: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly runIds: RunIdMode;
  readonly recentRuns: number;
  /** Host header names accepted besides IP literals and localhost (DNS rebinding guard). */
  readonly hosts: readonly string[];
}

/** Panel settings, or undefined when SANDLANE_STATUS_PORT is unset (the panel is off). */
export async function statusPanelConfig(env: Env): Promise<StatusPanelConfig | undefined> {
  const port = env.SANDLANE_STATUS_PORT;
  if (port === undefined || port === "") return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error("Invalid SANDLANE_STATUS_PORT");
  const bind = env.SANDLANE_STATUS_BIND ?? "127.0.0.1";
  if (!isIP(bind)) throw new Error("Invalid SANDLANE_STATUS_BIND");
  const runIds = env.SANDLANE_STATUS_RUN_IDS ?? "hash";
  if (!["plain", "hash", "none"].includes(runIds))
    throw new Error("Invalid SANDLANE_STATUS_RUN_IDS");
  const recent = env.SANDLANE_STATUS_RECENT_RUNS ?? "50";
  if (!/^[0-9]{1,3}$/.test(recent) || Number(recent) < 1 || Number(recent) > 500)
    throw new Error("Invalid SANDLANE_STATUS_RECENT_RUNS");
  const hosts = (env.SANDLANE_STATUS_HOSTS ?? "")
    .split(",")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length > 16 || !hosts.every(h => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)))
    throw new Error("Invalid SANDLANE_STATUS_HOSTS");
  const tokenSet =
    env.SANDLANE_STATUS_TOKEN !== undefined || env.SANDLANE_STATUS_TOKEN_FILE !== undefined;
  return Object.freeze({
    bind,
    port: Number(port),
    token: tokenSet ? await readSecret(env, "SANDLANE_STATUS_TOKEN") : undefined,
    runIds: runIds as RunIdMode,
    recentRuns: Number(recent),
    hosts: Object.freeze(hosts)
  });
}

export interface WorkerInfo {
  readonly version: string;
  /** Wall-clock start, ms. */
  readonly startedAt: number;
  readonly runtimeId: string;
  readonly nodeId?: string;
  readonly harnesses: readonly string[];
}

/** Sandbox node status (e.g. the Broker's): only the listed numeric and flag fields are shown. */
export type SandboxStatusSource = (signal: AbortSignal) => Promise<Record<string, unknown>>;

export interface SandboxView {
  readonly reachable: boolean;
  readonly checkedAt: string;
  readonly error?: string;
  readonly ready?: boolean;
  readonly nodeId?: string;
  readonly active?: number;
  readonly idleSessions?: number;
  readonly capacity?: number;
  readonly perTenant?: number;
  readonly queuedOperations?: number;
  readonly sessionIdleMs?: number;
  readonly network?: string;
  readonly harnesses?: readonly string[];
}

export type StatusDocument = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly worker: {
    readonly version: string;
    readonly startedAt: string;
    readonly uptimeMs: number;
    readonly runtimeId: string;
    readonly nodeId?: string;
    readonly harnesses: readonly string[];
  };
  readonly sandbox?: SandboxView;
} & StatusSnapshot;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Sandbox status is fetched at most this often, whatever the request rate. */
const SANDBOX_TTL_MS = 2_000;
const SANDBOX_TIMEOUT_MS = 2_000;

function sandboxView(raw: Record<string, unknown>, checkedAt: string): SandboxView {
  const count = (key: string) => {
    const value = raw[key];
    return Number.isSafeInteger(value) && (value as number) >= 0 ? { [key]: value as number } : {};
  };
  const harnesses = Array.isArray(raw.harnesses)
    ? raw.harnesses.filter(h => typeof h === "string" && IDENTIFIER.test(h)).slice(0, 16)
    : undefined;
  return {
    reachable: true,
    checkedAt,
    ...(typeof raw.ready === "boolean" ? { ready: raw.ready } : {}),
    ...(typeof raw.nodeId === "string" && IDENTIFIER.test(raw.nodeId)
      ? { nodeId: raw.nodeId }
      : {}),
    ...count("active"),
    ...count("idleSessions"),
    ...count("capacity"),
    ...count("perTenant"),
    ...count("queuedOperations"),
    ...count("sessionIdleMs"),
    ...(typeof raw.network === "string" && /^[a-z]{1,16}$/.test(raw.network)
      ? { network: raw.network }
      : {}),
    ...(harnesses ? { harnesses } : {})
  };
}

/** Assembles the status document: recorder state, Worker identity and the cached sandbox status. */
export class StatusPanel {
  #sandbox: { at: number; view: SandboxView } | undefined;
  #pending: Promise<SandboxView> | undefined;

  constructor(
    private readonly recorder: Pick<StatusRecorder, "snapshot">,
    private readonly worker: WorkerInfo,
    private readonly sandbox?: SandboxStatusSource,
    private readonly now: () => number = Date.now
  ) {}

  async document(): Promise<StatusDocument> {
    const sandbox = this.sandbox ? await this.#sandboxView() : undefined;
    const now = this.now();
    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      worker: {
        version: this.worker.version,
        startedAt: new Date(this.worker.startedAt).toISOString(),
        uptimeMs: Math.max(0, now - this.worker.startedAt),
        runtimeId: this.worker.runtimeId,
        ...(this.worker.nodeId ? { nodeId: this.worker.nodeId } : {}),
        harnesses: [...this.worker.harnesses]
      },
      ...(sandbox ? { sandbox } : {}),
      ...this.recorder.snapshot()
    };
  }

  /** Cached for SANDBOX_TTL_MS; concurrent requests share one fetch. */
  #sandboxView(): Promise<SandboxView> {
    const cached = this.#sandbox;
    if (cached && this.now() - cached.at < SANDBOX_TTL_MS) return Promise.resolve(cached.view);
    this.#pending ??= (async () => {
      const at = this.now();
      let view: SandboxView;
      try {
        view = sandboxView(
          await this.sandbox!(AbortSignal.timeout(SANDBOX_TIMEOUT_MS)),
          new Date(at).toISOString()
        );
      } catch (error) {
        const code = (error as { message?: unknown })?.message;
        view = {
          reachable: false,
          checkedAt: new Date(at).toISOString(),
          error:
            typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNAVAILABLE"
        };
      }
      this.#sandbox = { at, view };
      return view;
    })().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }
}

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison: both sides are hashed to the same length first, so neither the
 * content nor the length of the token shows in the timing. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  return presented !== undefined && timingSafeEqual(sha(expected), sha(presented));
}

const BASE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
});

/**
 * Read-only status server (Node http, no dependencies): GET/HEAD `/` (self-contained page that
 * polls the JSON every 2s) and `/status.json`. With a token, every request needs
 * `Authorization: Bearer <token>` or `?token=<token>`. Host names other than IP literals,
 * localhost and the configured ones are refused (DNS rebinding).
 */
export function createStatusServer(
  panel: Pick<StatusPanel, "document">,
  options: Pick<StatusPanelConfig, "token" | "hosts">
): http.Server {
  const hosts = new Set(["localhost", ...options.hosts]);
  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000 },
    (req, res) => {
      const reply = (
        status: number,
        type: string,
        body: string,
        extra: Record<string, string> = {}
      ) => {
        res.writeHead(status, {
          ...BASE_HEADERS,
          "content-type": type,
          "content-length": String(Buffer.byteLength(body)),
          ...extra
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };
      const error = (status: number, code: string, extra: Record<string, string> = {}) =>
        reply(status, "application/json; charset=utf-8", JSON.stringify({ error: code }), {
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
          ...extra
        });
      try {
        const host = (req.headers.host ?? "")
          .replace(/:[0-9]{1,5}$/, "")
          .replace(/^\[(.*)\]$/, "$1")
          .toLowerCase();
        if (!host || (!isIP(host) && !hosts.has(host))) return error(421, "STATUS_HOST_REFUSED");
        if (req.method !== "GET" && req.method !== "HEAD")
          return error(405, "STATUS_READ_ONLY", { allow: "GET, HEAD" });
        const url = new URL(req.url ?? "/", "http://status.invalid");
        if (url.pathname !== "/" && url.pathname !== "/status.json")
          return error(404, "STATUS_NOT_FOUND");
        if (options.token !== undefined) {
          const header = req.headers.authorization;
          const bearer =
            typeof header === "string" && /^Bearer [\x21-\x7e]{1,512}$/.test(header)
              ? header.slice(7)
              : undefined;
          const query = url.searchParams.getAll("token");
          const presented = bearer ?? (query.length === 1 ? query[0] : undefined);
          if (!tokenMatches(options.token, presented))
            return error(401, "STATUS_UNAUTHORIZED", { "www-authenticate": "Bearer" });
        }
        if (url.pathname === "/") {
          const nonce = randomBytes(16).toString("base64");
          return reply(200, "text/html; charset=utf-8", statusPage(nonce), {
            "content-security-policy":
              `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
              "connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; " +
              "frame-ancestors 'none'"
          });
        }
        panel.document().then(
          document => {
            if (res.destroyed) return;
            reply(200, "application/json; charset=utf-8", JSON.stringify(document), {
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
            });
          },
          () => {
            if (!res.destroyed && !res.headersSent) error(503, "STATUS_UNAVAILABLE");
          }
        );
      } catch {
        if (!res.headersSent) error(400, "STATUS_BAD_REQUEST");
      }
    }
  );
  server.maxConnections = 32;
  return server;
}
