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
import https from "node:https";
import { isIP } from "node:net";
import { Duplex, Readable } from "node:stream";

/** Upper bound for keeping an idle upstream connection, below typical proxy idle timeouts
 * (a measured relay kept idle connections for at least 60s). */
const IDLE_SOCKET_MS = 55_000;
/** A connection opened ahead of a request was closed by a measured relay after ~60s when no
 * request arrived on it, so an unused one is replaced well before that. */
const SPARE_MS = 50_000;
/** While an origin is in recent use, check this often that a ready connection is waiting. */
const REFRESH_MS = 20_000;
/** Keeping connections ready stops once an origin had no real request for this long. */
const REFRESH_WINDOW_MS = 10 * 60_000;

export type UpstreamSend = ((url: string, init: RequestInit) => Promise<Response>) & {
  /** Open a connection to the URL's origin in the background unless one is ready. */
  readonly warm?: (url: string) => void;
};

export interface WarmupOptions {
  readonly refreshMs?: number;
  readonly windowMs?: number;
  readonly spareMs?: number;
  /** Debug diagnostics: codes and durations only. */
  readonly log?: (code: string, fields: Readonly<Record<string, string | number>>) => void;
}

interface Spare {
  readonly socket: Duplex;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

/**
 * Agent that can open a connection before the first request. The next request to that host
 * takes it over even while its TLS handshake is still running, so it never waits longer than a
 * handshake of its own would have taken, and no request is sent just to warm up.
 */
class PreconnectAgent extends https.Agent {
  readonly #spares = new Map<string, Spare>();

  constructor(
    private readonly tlsOptions: https.AgentOptions,
    private readonly spareMs: number
  ) {
    super({
      keepAlive: true,
      timeout: IDLE_SOCKET_MS,
      maxFreeSockets: 8,
      scheduling: "lifo",
      ...tlsOptions
    });
  }

  /** True when a pooled idle connection or a spare living at least `minMs` more is ready. */
  ready(url: URL, minMs = 0): boolean {
    const spare = this.#spares.get(key(url.hostname, url.port));
    if (spare && spare.expiresAt - Date.now() >= minMs) return true;
    // Agent pool keys start with "host:port:" (followed by TLS options).
    const prefix = `${bare(url.hostname)}:${url.port || 443}:`;
    return Object.entries(this.freeSockets).some(
      ([name, list]) => name.startsWith(prefix) && list?.length
    );
  }

  preconnect(url: URL, log: NonNullable<WarmupOptions["log"]>): void {
    const host = bare(url.hostname);
    const port = Number(url.port || 443);
    const id = key(url.hostname, url.port);
    this.#drop(id);
    const started = performance.now();
    const socket = super.createConnection({
      ...this.tlsOptions,
      host,
      port,
      ...(isIP(host) ? {} : { servername: host })
    } as https.RequestOptions);
    if (!socket) return;
    const spare: Spare = {
      socket,
      expiresAt: Date.now() + this.spareMs,
      timer: setTimeout(() => this.#drop(id), this.spareMs).unref()
    };
    this.#spares.set(id, spare);
    socket.once("secureConnect", () =>
      log("UPSTREAM_PRECONNECTED", { elapsedMs: Math.round(performance.now() - started) })
    );
    // Also stays attached after a request took the socket over; the request has its own handler.
    socket.on("error", error => log("UPSTREAM_PRECONNECT_FAILED", { error: errorCode(error) }));
    socket.once("close", () => {
      if (this.#spares.get(id) === spare) this.#drop(id);
    });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, socket: Duplex) => void
  ): Duplex | null | undefined {
    const id = key(String(options.host ?? "localhost"), String(options.port ?? ""));
    const spare = this.#spares.get(id);
    if (spare) {
      this.#spares.delete(id);
      clearTimeout(spare.timer);
      if (!spare.socket.destroyed && Date.now() < spare.expiresAt) return spare.socket;
      spare.socket.destroy();
    }
    return super.createConnection(options, callback);
  }

  #drop(id: string): void {
    const spare = this.#spares.get(id);
    if (!spare) return;
    this.#spares.delete(id);
    clearTimeout(spare.timer);
    spare.socket.destroy();
  }
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");
const key = (hostname: string, port: string) => `${bare(hostname)}:${port || 443}`;
const errorCode = (error: unknown) =>
  String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name);

/**
 * fetch-compatible sender over a keep-alive https.Agent.
 *
 * Global fetch closes idle connections after ~4s, so every user turn paid a fresh TCP+TLS
 * handshake to the model service (1.1–2.9s through the local VPN, versus ~0.37s for a request
 * on a warm connection). Reusing connections between turns removes that from first-token time.
 *
 * Only what the Responses provider needs is supported: string bodies, no redirects, AbortSignal.
 * A request on a reused socket that the server closed meanwhile (ECONNRESET before any
 * response) was never processed and is retried once on a fresh connection, as Node documents.
 * A failure after the response began (e.g. a reset mid-stream) is never retried.
 *
 * `warm` opens a connection (TCP + TLS only, nothing is sent) when none is ready, so a Run's
 * first model request skips the handshake; it is called when a Run is claimed, in parallel with
 * sandbox preparation. Origins with a real request in the last `windowMs` keep a ready
 * connection between turns. Warming never throws; failures are logged at debug level.
 */
export function keepAliveSend(
  options: https.AgentOptions = {},
  warmup: WarmupOptions = {}
): UpstreamSend {
  const agent = new PreconnectAgent(options, warmup.spareMs ?? SPARE_MS);
  const once = (url: URL, init: RequestInit, fresh: boolean) =>
    new Promise<Response>((resolve, reject) => {
      // Once a response started, the server has processed the request: never send it again.
      let responded = false;
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => (headers[key] = value));
      const request = https.request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          ...(fresh ? { agent: false as const, ...options } : { agent }),
          ...(init.signal ? { signal: init.signal } : {})
        },
        response => {
          responded = true;
          const status = response.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          const empty = status === 204 || status === 304 || init.method === "HEAD";
          if (empty) response.resume();
          resolve(
            new Response(
              empty ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
              { status, headers: responseHeaders }
            )
          );
        }
      );
      request.on("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (!fresh && !responded && request.reusedSocket && code === "ECONNRESET") {
          once(url, init, true).then(resolve, reject);
          return;
        }
        reject(error);
      });
      if (typeof init.body === "string") request.end(init.body);
      else if (init.body === undefined || init.body === null) request.end();
      else {
        request.destroy();
        reject(new Error("UNSUPPORTED_BODY"));
      }
    });

  const refreshMs = warmup.refreshMs ?? REFRESH_MS;
  const windowMs = warmup.windowMs ?? REFRESH_WINDOW_MS;
  const log =
    warmup.log ??
    ((code, fields) =>
      console.debug(JSON.stringify({ type: "model-upstream", level: "debug", code, ...fields })));
  // Origins with a recent real request, kept ready between turns until the window ends.
  const recent = new Map<string, { lastUsed: number; timer: NodeJS.Timeout }>();
  const used = (url: URL) => {
    const current = recent.get(url.origin);
    if (current) {
      current.lastUsed = Date.now();
      return;
    }
    const entry = {
      lastUsed: Date.now(),
      timer: setInterval(() => {
        if (Date.now() - entry.lastUsed > windowMs) {
          clearInterval(entry.timer);
          recent.delete(url.origin);
        } else if (!agent.ready(url, refreshMs)) agent.preconnect(url, log);
      }, refreshMs).unref()
    };
    recent.set(url.origin, entry);
  };

  const send = async (url: string, init: RequestInit) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || (init.redirect && init.redirect !== "error"))
      throw new Error("UNSUPPORTED_REQUEST");
    used(target);
    return once(target, init, false);
  };
  return Object.assign(send, {
    warm: (url: string) => {
      try {
        const target = new URL(url);
        if (target.protocol === "https:" && !agent.ready(target)) agent.preconnect(target, log);
      } catch (error) {
        log("UPSTREAM_PRECONNECT_FAILED", { error: errorCode(error) });
      }
    }
  });
}
