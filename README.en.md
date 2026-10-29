<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Project overview, architecture, and usage guide for Purefect SandLane.
-->

# Purefect SandLane

[English](./README.en.md) | [简体中文](./README.md)

[Documentation](./docs/README.md) · [Quick start](./docs/demo.md) · [Purefect Labs open source](https://www.purefect.cn/en/opensource)

Purefect SandLane is a self-hosted Agent CLI execution plane designed for multi-tenant, multi-user control planes. It runs Codex, Claude Code, Qwen Code, and OpenCode in ephemeral containers while keeping provider API keys and user tokens inside a trusted Worker process.

The Worker claims Runs from a control plane and gives each sandbox only short-lived, Run-scoped capabilities. Model requests and MCP tool calls pass through gateways that validate those capabilities before forwarding traffic upstream. SandLane therefore separates untrusted CLI execution from long-lived credentials and business systems without requiring the CLI container to have direct Internet access.

Model providers and Agent CLIs are configured separately; SandLane is not limited to OpenAI or Anthropic models. Chinese providers such as DeepSeek, GLM, and Qwen can connect through compatible Responses or Anthropic Messages endpoints. Configure the endpoint, model name, and API key in your control plane. DeepSeek `deepseek-flash` has passed real text and MCP tool smoke tests with all four built-in CLIs: Codex, Claude Code, Qwen Code, and OpenCode. Live GLM and Qwen model-service calls remain unverified, and the selected model and plan must support the required protocol. See the [model integration guide](./docs/model-providers.md) for setup and limitations.

Model extensions are not limited to these providers: Kimi (Moonshot AI), Google Gemini, and others are also potential integration targets. SandLane already implements a trusted Worker-side `ModelUpstreamFactory` extension point. Services matching the existing protocols can be configured directly; different native protocols or authentication schemes require an upstream adapter that maps requests, streaming responses, tool calls, and usage to the existing gateway contract. Kimi and Gemini have not been verified, and dedicated protocol adapters are not bundled. Chat Completions compatibility alone does not make a service directly usable with the existing Drivers.

Agent CLIs are extensible too. Codex, Claude Code, Qwen Code, and OpenCode are built in. The project publishes Apache-2.0 Codex and Qwen Code images and an MIT-licensed OpenCode image; Qwen Code and OpenCode use the Responses gateway and initially expose only Run-authorized MCP tools. Another CLI still requires an explicit `HarnessDriver`, launch configuration, pinned image, and compatibility tests; changing a tool name is not enough. See [Qwen Code and OpenCode](./docs/qwen-code-and-opencode.md) and the [standalone integration guide](./docs/standalone.md).

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
- `ghcr.io/purefect-labs/purefect-sandlane-qwen-code`
- `ghcr.io/purefect-labs/purefect-sandlane-opencode`

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

## Standalone demo

With Node.js 22+, Docker Engine 28+ (or a matching Docker Desktop), and Compose installed, run:

```bash
npm ci
npm run demo
```

No Purefect Engine, sibling repository, or model account is required. An in-memory control plane and protocol fixture exercise real Docker, Broker, Relay, TLS model and MCP requests. The demo removes its containers, networks, and volumes afterward. It is not actual Claude Code or a production control plane. See [the demo guide](./docs/demo.md) for cancellation, lease loss, and optional real CLI mode. Documentation other than this README is maintained in Chinese.

For interactive answers from a real model, use `npm run demo:chat -- ...` with an explicit CLI image, model endpoint, model identifier, and key file. The terminal displays the answer, CLI version, configured model identifier, elapsed time, and token usage when available. Each question runs independently without history and incurs provider charges. See [interactive setup](./docs/demo.md#交互式真实模型问答).

## Integrating another control plane

External MCP tools can use administrator-configured Streamable HTTP services or preinstalled stdio programs. Sandboxes share services/programs while credentials and client sessions are isolated per invocation using tenant/user bindings. The existing Purefect Client integration remains available. See the [MCP setup guide](./docs/mcp.md) for configuration and limitations.

The experimental `@purefect/sandlane/runtime/managed` export provides `createManagedRuntime(options)`. Supply your control plane, tools, context, Broker, and TLS configuration to reuse the bundled Docker, Harness, and gateway implementations. See [standalone integration](./docs/standalone.md) for examples and tarball installation. Use the lower-level API below for other sandbox implementations.

The `@purefect/sandlane/runtime` package exports `createRuntime(options)`. The caller explicitly supplies the `ControlPlane`, `ContextProvider`, `SandboxProvider`, credential registry, execution lanes, gateway endpoints, and resources that must close with the runtime. The returned handle exposes `drain()`, `close()`, and `done`.

Protocol types are exported from `@purefect/sandlane/spi/*`. The generic runtime composes process lifecycle and execution lanes; it does not select an upstream model, tool implementation, network topology, or business prompt for the caller. It neither reads environment variables nor imports the Purefect plugin.

This repository also includes a Purefect composition root. The current command-line Worker, `dist/bin/worker.js` (`npm run runtime:purefect`), is the Purefect-specific entry point.

## Isolation and credentials

The bundled Broker uses digest-pinned CLI images. Containers run as a non-root user with a read-only root filesystem, dropped Linux capabilities, and `no-new-privileges`. Workspaces, temporary directories, and CLI state use size-limited tmpfs mounts. The Broker enforces configured resource, concurrency, and per-tenant capacity limits.

Control-plane `agent_token` values and model API keys remain in Worker memory. The Worker creates separate model and tool capabilities for every Run. Each gateway binds a capability to its Run, protocol, purpose, and lease lifetime, and invalidates it when the Run finishes or its lease is lost or revoked.

The Broker supports `none` and `isolated` network modes. The bundled Worker composition uses an isolated network, a Relay binding, and managed gateway policy. The Relay holds no provider key, user token, or Run credential. Model-hosted web search is restricted by lease policy at the model gateway; it does not give the sandbox arbitrary network access.

The default sandbox implementation uses Docker and provides a container-level isolation boundary. Deployments handling hostile tenants or highly sensitive workloads can implement the `SandboxProvider` SPI and a custom composition to use tenant-dedicated nodes, virtual machines, microVMs, or another stronger isolation mechanism. Those implementations are not included in this repository and must independently verify resource enforcement, network isolation, credential cleanup, cancellation, lease loss, and failure recovery.

## Using other model providers

Agent CLIs and model providers are configured separately: Codex, Qwen Code, and OpenCode use
Responses; Claude Code uses Anthropic Messages. Compatible DeepSeek, GLM, and Qwen endpoints can
reuse these protocol paths through the SandLane gateway, keeping real API keys in the Worker. A new
model brand does not require a new CLI or Sandbox Agent.

See the [model integration guide](./docs/model-providers.md) for endpoints, region/plan restrictions,
authentication, verification commands, and the trusted `ModelUpstreamFactory` extension. DeepSeek
`deepseek-flash` passed both protocol probes and real Docker text/MCP smoke tests with Codex,
Claude Code, Qwen Code, and OpenCode.
GLM and Qwen have offline protocol coverage only; their live combinations remain unverified.
Chat Completions compatibility alone does not establish Responses compatibility.

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

- [Documentation index](./docs/README.md)
- [Standalone demo](./docs/demo.md)
- [Standalone integration and public API](./docs/standalone.md)
- [Purefect reference integration](./docs/integrations/purefect.md)
Detailed operational documentation is currently available in Simplified Chinese:

- [Installation and startup](./docs/installation.md)
- [Configuration reference](./docs/configuration.md)
- [Model providers and compatibility checks](./docs/model-providers.md)
- [Operations](./docs/operations.md)
- [Execution runtime and Purefect contract](./docs/control-plane.md)
- [Web access](./docs/web-access.md)
- [Claude Code support](./docs/claude-code.md)
- [Qwen Code and OpenCode](./docs/qwen-code-and-opencode.md)
- [Tools and page actions](./docs/tools-and-page-actions.md)
- [Status panel](./docs/status-panel.md)
- [Memory integration](./docs/memory.md)
- [Security](./SECURITY.md)
- [Development and contributing](./CONTRIBUTING.md)

## Project scope and current limitations

SandLane is an execution plane, not a complete cloud platform. The integrating control plane remains responsible for identity, business authorization, durable queueing, billing, audit policy, and general-purpose scheduling.

- `runtime:purefect` is platform-specific; the standalone demo and managed API do not depend on Purefect. The SPI retains v1 compatibility fields and some historical business semantics.
- The Worker does not durably persist or replay Run state. If the process stops, it does not replay the prompt; the control plane must arbitrate the final state of an already-started Run.
- The built-in SQLite memory provider is for single-host deployments. Shared deployments require an external implementation.
- CI exercises credential-free Docker fixtures for success, cancellation, and lease loss. It does not validate real providers or the Purefect platform. Before production use, validate actual CLIs, the control plane, resource limits, and failure recovery on the target Linux environment.

## Project and community

SandLane is Purefect's open-source Agent CLI execution component, usable independently or with different control planes.
Visit [Purefect Labs open source](https://www.purefect.cn/en/opensource) for product and project background.
SandLane's usage guides and technical details live in the [repository documentation](./docs/README.md).
Report issues and suggest features through [GitHub Issues](https://github.com/purefect-labs/purefect-sandlane/issues).

## License

Purefect SandLane is licensed under the [Apache License 2.0](./LICENSE). Additional attribution and notices are available in [NOTICE](./NOTICE).

Third-party Agent CLIs in public images or installed by the deployer, model providers, and connected services remain subject to their own licenses and terms. See [Claude Code support](./docs/claude-code.md) for considerations relevant to multi-tenant use.
