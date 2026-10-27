<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Project overview, architecture, and usage guide for Purefect SandLane.
-->

# Purefect SandLane

[English](./README.en.md) | [简体中文](./README.md)

Purefect SandLane is a self-hosted Agent CLI execution plane designed for multi-tenant, multi-user control planes. It runs tools such as Codex and Claude Code in ephemeral containers while keeping provider API keys and user tokens inside a trusted Worker process.

The Worker claims Runs from a control plane and gives each sandbox only short-lived, Run-scoped capabilities. Model requests and MCP tool calls pass through gateways that validate those capabilities before forwarding traffic upstream. SandLane therefore separates untrusted CLI execution from long-lived credentials and business systems without requiring the CLI container to have direct Internet access.

[![CI](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml/badge.svg)](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml)

## What SandLane solves

SandLane provides the execution-layer building blocks needed when a control plane must run Agent CLIs on behalf of multiple users or tenants:

- Ephemeral, resource-constrained workspaces for each Run
- Run-scoped access to approved models and MCP tools
- Separation of provider credentials and user tokens from sandboxed processes
- Lease-aware cancellation, cleanup, and capacity control
- A control-plane-neutral runtime composition API
- A ready-made integration for the Purefect control plane

SandLane is useful for internal AI platforms, hosted development environments, workflow automation systems, and SaaS products that need to execute Agent CLIs for different users while retaining centralized control over identity, authorization, models, tools, and resource policy.

## Runtime components

Run `npm ci && npm run build` before starting the processes required by your deployment topology.

| Process         | Entry point                | Responsibility                                                                                                                      |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Purefect Worker | `npm run runtime:purefect` | Claims, synchronizes, and completes Runs; manages Run credentials; hosts the model and MCP TLS gateways; drives Agent CLI harnesses |
| Broker          | `npm run broker`           | Manages Docker allocations, capacity, leases, staged input files, and cleanup on a Linux node                                       |
| Relay           | `node dist/bin/relay.js`   | Provides fixed TCP routes from an isolated Docker network to the Worker's two gateways                                              |

Version tags publish multi-architecture images through GitHub Actions:

- `ghcr.io/purefect-labs/purefect-sandlane-runtime`
- `ghcr.io/purefect-labs/purefect-sandlane-relay`

These entry points do not load `.env.local` automatically. Inject configuration explicitly with `node --env-file=.env.local ...`, a systemd `EnvironmentFile`, or container-platform secrets. See [Installation and startup](./docs/installation.md) and [Configuration reference](./docs/configuration.md) for the current deployment requirements.

The optional status panel is a read-only operations interface, not a Run submission API.

## Architecture

```text
Control plane (claim / sync / complete)
                  │
                  ▼
Worker process
  ├── execution lanes + in-memory Run credential registry
  ├── TLS model gateway ────────────────► leased upstream model
  ├── TLS MCP gateway ──────────────────► authorized tools and APIs
  └── Unix socket ──────────────────────► node-local Broker
                                            │
                                            ▼
                              ephemeral CLI container
                              - read-only root filesystem
                              - tmpfs workspace/state
                              - model + tool capabilities only
                              - no direct Internet access
                                            │
                              isolated network
                                            │
                                            ▼
                              fixed-route Relay
                                            │
                          model gateway + MCP gateway
```

## Integrating another control plane

The `@purefect/sandlane/runtime` package exports `createRuntime(options)`. The caller explicitly supplies the `ControlPlane`, `ContextProvider`, `SandboxProvider`, credential registry, execution lanes, gateway endpoints, and resources that must close with the runtime. The returned handle exposes `drain()`, `close()`, and `done`.

Protocol types are exported from `@purefect/sandlane/spi/*`. The generic runtime composes process lifecycle and execution lanes; it does not select an upstream model, tool implementation, network topology, or business prompt for the caller. It neither reads environment variables nor imports the Purefect plugin.

This repository also includes a Purefect composition root. The current command-line Worker, `dist/bin/worker.js` (`npm run runtime:purefect`), is the Purefect-specific entry point.

## Isolation and credentials

The bundled Broker uses digest-pinned CLI images. Containers run as a non-root user with a read-only root filesystem, dropped Linux capabilities, and `no-new-privileges`. Workspaces, temporary directories, and CLI state use size-limited tmpfs mounts. The Broker enforces configured resource, concurrency, and per-tenant capacity limits.

Control-plane `agent_token` values and model API keys remain in Worker memory. The Worker creates separate model and tool capabilities for every Run. Each gateway binds a capability to its Run, protocol, purpose, and lease lifetime, and invalidates it when the Run finishes or its lease is lost or revoked.

The Broker supports `none` and `isolated` network modes. The bundled Worker composition uses an isolated network, a Relay binding, and managed gateway policy. The Relay holds no provider key, user token, or Run credential. Model-hosted web search is restricted by lease policy at the model gateway; it does not give the sandbox arbitrary network access.

The default sandbox implementation uses Docker and provides a container-level isolation boundary. Deployments handling hostile tenants or highly sensitive workloads can implement the `SandboxProvider` SPI and a custom composition to use tenant-dedicated nodes, virtual machines, microVMs, or another stronger isolation mechanism. Those implementations are not included in this repository and must independently verify resource enforcement, network isolation, credential cleanup, cancellation, lease loss, and failure recovery.

## File mode

File mode is enabled only when a lease includes session files. The Worker downloads short-lived HTTPS files on the host, and the Broker writes them with a manifest to `/workspace/inputs` before starting the CLI. The CLI can then read the staged files and use command-line tools.

File contents are untrusted. Prompt injection can still induce the CLI to modify the current Run's workspace or invoke capabilities already authorized for that Run. See [Security](./SECURITY.md) and the [file-mode configuration reference](./docs/configuration.md#文件模式读文件与命令行) for trust boundaries and residual risks.

## Quick verification

```bash
npm ci
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

`npm test` builds the project and runs the `node:test` suite. It does not start Docker containers or call live model or Purefect services. The Docker and native CLI validation scripts in this repository are explicit integration tools and are not part of the default test command.

## Documentation

Detailed operational documentation is currently available in Simplified Chinese:

- [Installation and startup](./docs/installation.md)
- [Configuration reference](./docs/configuration.md)
- [Operations](./docs/operations.md)
- [Execution runtime and Purefect contract](./docs/control-plane.md)
- [Web access](./docs/web-access.md)
- [Claude Code support](./docs/claude-code.md)
- [Tools and page actions](./docs/tools-and-page-actions.md)
- [Status panel](./docs/status-panel.md)
- [Memory integration](./docs/memory.md)
- [Security](./SECURITY.md)
- [Development and contributing](./CONTRIBUTING.md)

## Project scope and current limitations

SandLane is an execution plane, not a complete cloud platform. The integrating control plane remains responsible for identity, business authorization, durable queueing, billing, audit policy, and general-purpose scheduling.

- The bundled command-line Worker directly composes the Purefect plugin. Other control planes must build their own composition with the generic runtime API.
- The Worker does not durably persist or replay Run state. If the process stops, it does not replay the prompt; the control plane must arbitrate the final state of an already-started Run.
- The built-in SQLite memory provider is for single-host deployments. Shared deployments require an external implementation.
- End-to-end Docker and control-plane validation is not part of the default CI suite. Before production use, validate the images, Relay, TLS, resource limits, shutdown behavior, lease-loss paths, and failure recovery on the target Linux environment.

## License

Purefect SandLane is licensed under the [Apache License 2.0](./LICENSE). Additional attribution and notices are available in [NOTICE](./NOTICE).

SandLane only launches third-party Agent CLIs installed by the deployer. Those CLIs, model providers, and connected services remain subject to their own licenses and terms. See [Claude Code support](./docs/claude-code.md) for considerations relevant to multi-tenant use.
