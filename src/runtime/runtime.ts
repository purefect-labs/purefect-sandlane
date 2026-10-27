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
import type { Server } from "node:http";
import { ExecutionLane, type LaneLog, type LaneOptions } from "../core/worker.js";
import type { RunCredentialRegistry } from "../core/credentials.js";
import type { ControlPlane } from "../spi/control-plane.js";
import type { SandboxProvider } from "../spi/sandbox.js";
import type { StatusObserver } from "../spi/status.js";

export interface RuntimeEndpoint {
  readonly server: Server;
  readonly bind: string;
  /** Use 0 in tests or embedded deployments to request an ephemeral port. */
  readonly port: number;
}

export interface RuntimeResource {
  close(): void | Promise<void>;
}

export interface RuntimeOptions {
  readonly controlPlane: ControlPlane;
  readonly sandbox: SandboxProvider;
  readonly credentials: RunCredentialRegistry;
  readonly concurrency: number;
  /** Shared options copied into every execution lane. */
  readonly lane: Omit<LaneOptions, "observe">;
  /** Optional per-lane observer. The index is stable for the lifetime of the Runtime. */
  readonly observeLane?: (index: number) => StatusObserver;
  /** Servers owned by this Runtime. They are listened before claims start and closed on stop. */
  readonly endpoints?: readonly RuntimeEndpoint[];
  /** Other composition-owned resources, closed after all lanes and endpoints stop. */
  readonly resources?: readonly RuntimeResource[];
  readonly log?: LaneLog;
}

export interface RuntimeHandle {
  /** Resolves after every lane has stopped and all owned resources have been closed. */
  readonly done: Promise<void>;
  /** Stop claiming. Runs already in progress may finish. */
  drain(): void;
  /** Cancel remaining work and wait for deterministic cleanup. Idempotent. */
  close(): Promise<void>;
}

async function listen({ server, port, bind }: RuntimeEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, bind);
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function closeResources(resources: readonly RuntimeResource[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const resource of [...resources].reverse()) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Starts a control-plane-neutral SandLane Runtime. All business integrations and infrastructure
 * implementations are supplied by the caller; this module does not read process.env, install
 * tools, select a model provider or import an application plugin.
 */
export async function createRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 16
  )
    throw new Error("INVALID_RUNTIME_CONCURRENCY");

  const endpoints = Object.freeze([...(options.endpoints ?? [])]);
  const resources = Object.freeze([...(options.resources ?? [])]);
  const lanes = Array.from(
    { length: options.concurrency },
    (_, index) =>
      new ExecutionLane(options.controlPlane, options.sandbox, options.credentials, {
        ...options.lane,
        ...(options.observeLane ? { observe: options.observeLane(index) } : {})
      })
  );
  const started: Server[] = [];
  try {
    for (const endpoint of endpoints) {
      await listen(endpoint);
      started.push(endpoint.server);
    }
  } catch (error) {
    await Promise.allSettled(started.map(closeServer));
    await closeResources(resources);
    throw error;
  }

  const abort = new AbortController();
  let closing: Promise<void> | undefined;
  const stopped = Promise.all(lanes.map(lane => lane.run(abort.signal))).then(() => undefined);
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const server of started.reverse()) {
      try {
        await closeServer(server);
      } catch (error) {
        failures.push(error);
      }
    }
    failures.push(...(await closeResources(resources)));
    if (failures.length) throw new AggregateError(failures, "RUNTIME_CLEANUP_FAILED");
  };
  const done = stopped.finally(cleanup);

  const drain = () => {
    for (const lane of lanes) lane.drain();
  };
  const close = () => {
    if (!closing) {
      drain();
      abort.abort();
      closing = done;
    }
    return closing;
  };
  try {
    options.log?.("RUNTIME_STARTED", { lanes: lanes.length });
  } catch {
    /* Diagnostics never affect the Runtime. */
  }
  return Object.freeze({ done, drain, close });
}
