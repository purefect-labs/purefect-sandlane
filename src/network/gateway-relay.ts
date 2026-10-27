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
import net from "node:net";

export interface GatewayRoute {
  listenHost: string;
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
}

export interface RelayLimits {
  maxConnections: number;
  perAddress: number;
  connectMs: number;
  idleMs: number;
  lifetimeMs: number;
  bytesPerDirection: number;
}

const defaults: RelayLimits = {
  maxConnections: 64,
  perAddress: 8,
  connectMs: 5000,
  idleMs: 60000,
  lifetimeMs: 120000,
  bytesPerDirection: 8 * 1024 * 1024
};

/** Fixed TCP destinations only: TLS remains end-to-end between CLI and Gateway.
 * This is neither an HTTP CONNECT proxy nor an authorization service. Network
 * ownership and Gateway Run authorization must be enforced independently.
 */
export class GatewayRelay {
  private readonly routes: readonly Readonly<GatewayRoute>[];
  private readonly limits: Readonly<RelayLimits>;
  private readonly servers: net.Server[] = [];
  private readonly connections = new Set<() => void>();
  private readonly addresses = new Map<string, number>();
  private state: "new" | "starting" | "running" | "closed" = "new";

  constructor(routes: readonly GatewayRoute[], limits: Partial<RelayLimits> = {}) {
    this.limits = Object.freeze({ ...defaults, ...limits });
    const port = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 65535;
    if (
      routes.length < 1 ||
      routes.length > 2 ||
      routes.some(
        r =>
          !net.isIP(r.listenHost) ||
          !net.isIP(r.upstreamHost) ||
          !port(r.listenPort) ||
          !port(r.upstreamPort)
      ) ||
      Object.values(this.limits).some(v => !Number.isSafeInteger(v) || v < 1) ||
      this.limits.maxConnections > 1024 ||
      this.limits.perAddress > this.limits.maxConnections ||
      this.limits.lifetimeMs > 300000 ||
      this.limits.connectMs > this.limits.lifetimeMs ||
      this.limits.idleMs > this.limits.lifetimeMs ||
      this.limits.bytesPerDirection > 16 * 1024 * 1024
    )
      throw new Error("INVALID_GATEWAY_RELAY_CONFIGURATION");
    // No later caller mutation or DNS lookup can change the destination.
    this.routes = Object.freeze(routes.map(r => Object.freeze({ ...r })));
  }

  async start(): Promise<void> {
    if (this.state !== "new") throw new Error("GATEWAY_RELAY_ALREADY_STARTED");
    this.state = "starting";
    try {
      for (const route of this.routes) {
        const server = net.createServer({ allowHalfOpen: true }, socket =>
          this.accept(socket, route)
        );
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(route.listenPort, route.listenHost, () => {
            server.off("error", reject);
            resolve();
          });
        });
        // Listener failure takes the whole relay out of service, not one route silently.
        server.on("error", () => {
          void this.close();
        });
        if (this.state !== "starting") throw new Error("GATEWAY_RELAY_CLOSED");
      }
      this.state = "running";
    } catch {
      await this.close();
      throw new Error("GATEWAY_RELAY_START_FAILED");
    }
  }

  private accept(client: net.Socket, route: Readonly<GatewayRoute>): void {
    const address = client.remoteAddress ?? "unknown";
    const count = this.addresses.get(address) ?? 0;
    if (
      this.state !== "running" ||
      this.connections.size >= this.limits.maxConnections ||
      count >= this.limits.perAddress
    ) {
      client.destroy();
      return;
    }
    const upstream = new net.Socket({ allowHalfOpen: true });
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      clearTimeout(lifetimeTimer);
      client.destroy();
      upstream.destroy();
      this.connections.delete(stop);
      const remaining = (this.addresses.get(address) ?? 1) - 1;
      if (remaining) this.addresses.set(address, remaining);
      else this.addresses.delete(address);
    };
    const connectTimer = setTimeout(stop, this.limits.connectMs);
    const lifetimeTimer = setTimeout(stop, this.limits.lifetimeMs);
    this.connections.add(stop);
    this.addresses.set(address, count + 1);
    for (const socket of [client, upstream]) {
      socket.on("error", stop);
      socket.setTimeout(this.limits.idleMs, stop);
    }
    client.on("close", stop);
    upstream.on("close", () => {
      // Normal upstream EOF can precede draining the client's writable buffer.
      // pipe ends that buffer in order; a premature reset still stops both sides.
      if (!upstream.readableEnded || !upstream.writableFinished) stop();
    });
    // Transform-free pipe keeps Node's socket backpressure. Check the byte ceiling
    // before pipe's data listener; destroying both sockets prevents further forwarding.
    for (const socket of [client, upstream]) {
      let bytes = 0;
      socket.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > this.limits.bytesPerDirection) stop();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.connect(route.upstreamPort, route.upstreamHost, () => clearTimeout(connectTimer));
  }

  /** Shutdown closes active streams too; no connection survives a relay replacement. */
  async close(): Promise<void> {
    this.state = "closed";
    for (const stop of this.connections) stop();
    await Promise.all(
      this.servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
  }
}
