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
import { createHash } from "node:crypto";
import { BrokerError, object } from "./contracts.js";
import type { Engine } from "./docker-engine.js";
import { verifyRelay, type RelayBinding } from "./relay-binding.js";

export interface NetworkBinding {
  ref: { allocationId: string };
  digest: string;
  networkId?: string;
  relay?: Readonly<RelayBinding>;
}

/** Broker-only Docker network operations. The allocation intent must be durable
 * before create; the inspected immutable ID must be saved before creating a Run.
 * An optional pinned infrastructure Relay is the only additional allowed member.
 */
export class RunNetworks {
  private readonly owner: string;
  constructor(
    private readonly engine: Engine,
    private readonly nodeId: string,
    private readonly labelPrefix: string
  ) {
    this.owner = `${labelPrefix}.broker`;
  }

  private name(binding: NetworkBinding): string {
    return `sandlane-net-${createHash("sha256").update(`${this.nodeId}:${binding.ref.allocationId}`).digest("hex")}`;
  }

  private labels(binding: NetworkBinding): Record<string, string> {
    return {
      [this.owner]: this.nodeId,
      [`${this.owner}.allocation`]: binding.ref.allocationId,
      [`${this.owner}.digest`]: binding.digest,
      [`${this.owner}.network-policy`]: "isolated-v1"
    };
  }

  private async inspect(binding: NetworkBinding): Promise<Record<string, unknown> | undefined> {
    let info: Record<string, unknown>;
    try {
      info = object(
        await this.engine.request("GET", `/networks/${binding.networkId ?? this.name(binding)}`)
      );
    } catch (error) {
      if (!(error instanceof BrokerError) || error.status !== 404) throw error;
      // If an ID vanished, a replacement under the old name is never adopted/deleted.
      if (binding.networkId) {
        const { networkId: _id, ...byName } = binding;
        if (await this.inspect(byName))
          throw new BrokerError("NETWORK_REPLACED", 409, "Network identity changed");
      }
      return;
    }
    const labels = object(info.Labels);
    if (
      typeof info.Id !== "string" ||
      !/^[a-f0-9]{64}$/.test(info.Id) ||
      (binding.networkId !== undefined && info.Id !== binding.networkId) ||
      info.Name !== this.name(binding) ||
      Object.entries(this.labels(binding)).some(([key, value]) => labels[key] !== value)
    ) {
      throw new BrokerError("NETWORK_OWNERSHIP_MISMATCH", 409, "Network ownership mismatch");
    }
    return info;
  }

  async create(binding: NetworkBinding): Promise<string> {
    const version = object(await this.engine.request("GET", "/version"));
    if (
      typeof version.Version !== "string" ||
      !/^\d+\.\d+\.\d+/.test(version.Version) ||
      Number(version.Version.split(".")[0]) < 28
    ) {
      throw new BrokerError(
        "NETWORK_ENGINE_UNSUPPORTED",
        503,
        "Docker 28 or newer required for isolated gateway mode"
      );
    }
    const created = object(
      await this.engine.request("POST", "/networks/create", {
        Name: this.name(binding),
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Labels: this.labels(binding),
        Options: {
          "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
          "com.docker.network.bridge.enable_icc": "true"
        }
      })
    );
    if (typeof created.Id !== "string" || !/^[a-f0-9]{64}$/.test(created.Id)) {
      throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid network ID");
    }
    await this.validate({ ...binding, networkId: created.Id }, undefined, false);
    return created.Id;
  }

  async connectRelay(binding: NetworkBinding): Promise<void> {
    if (!binding.relay) return;
    await verifyRelay(this.engine, this.nodeId, this.labelPrefix, binding.relay);
    const info = await this.inspect(binding);
    if (!info || !binding.networkId)
      throw new BrokerError("NETWORK_MISSING", 503, "Network unavailable");
    await this.engine.request("POST", `/networks/${binding.networkId}/connect`, {
      Container: binding.relay.containerId
    });
    await this.validate(binding);
  }

  async relayAddress(binding: NetworkBinding, containerId?: string): Promise<string> {
    await this.validate(binding, containerId);
    const info = await this.inspect(binding);
    if (!info || !binding.relay)
      throw new BrokerError("RELAY_DISCONNECTED", 503, "Relay unavailable");
    const endpoint = object(object(info.Containers)[binding.relay.containerId]);
    if (typeof endpoint.IPv4Address !== "string")
      throw new BrokerError("ENGINE_PROTOCOL", 502, "Invalid Relay endpoint");
    return endpoint.IPv4Address.split("/")[0]!;
  }

  async validate(
    binding: NetworkBinding,
    containerId?: string,
    requireRelay = true
  ): Promise<void> {
    const info = await this.inspect(binding);
    if (
      !info ||
      info.Driver !== "bridge" ||
      info.Internal !== true ||
      info.EnableIPv6 !== false ||
      object(info.Options)["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
      Object.keys(object(info.Containers)).some(
        id => id !== containerId && id !== binding.relay?.containerId
      )
    ) {
      throw new BrokerError("NETWORK_POLICY_MISMATCH", 503, "Isolated network policy unavailable");
    }
    if (binding.relay && requireRelay) {
      await verifyRelay(this.engine, this.nodeId, this.labelPrefix, binding.relay);
      if (!Object.hasOwn(object(info.Containers), binding.relay.containerId))
        throw new BrokerError("RELAY_DISCONNECTED", 503, "Pinned Relay is not connected");
    }
  }

  async remove(binding: NetworkBinding): Promise<void> {
    let info = await this.inspect(binding);
    if (!info) return;
    if (binding.relay && Object.hasOwn(object(info.Containers), binding.relay.containerId)) {
      // Cleanup uses the original persisted identity, never today's replacement Relay.
      await verifyRelay(this.engine, this.nodeId, this.labelPrefix, binding.relay, false);
      await this.engine.request("POST", `/networks/${String(info.Id)}/disconnect`, {
        Container: binding.relay.containerId,
        Force: false
      });
      info = await this.inspect(binding);
      if (!info) return;
    }
    // Never forcibly detach an unexpected container or remove shared infrastructure.
    if (Object.keys(object(info.Containers)).length !== 0) {
      throw new BrokerError("NETWORK_IN_USE", 409, "Network still has endpoints");
    }
    await this.engine.request("DELETE", `/networks/${String(info.Id)}`);
    if (await this.inspect({ ...binding, networkId: String(info.Id) })) {
      throw new BrokerError("NETWORK_CLEANUP_PENDING", 503, "Network deletion unconfirmed");
    }
  }

  async assertNoOrphans(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${this.owner}=${this.nodeId}`] }));
    const networks = await this.engine.request("GET", `/networks?filters=${filters}`);
    if (!Array.isArray(networks) || networks.length !== 0) {
      throw new BrokerError("ORPHANED_NETWORK", 503, "Unaccounted networks prevent admission");
    }
  }
}
