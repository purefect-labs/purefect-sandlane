# Changelog

All notable changes to Purefect SandLane are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public runtime APIs remain
experimental during the `0.x` series; adopters should pin versions and review changes before
upgrading.

## [Unreleased]

## [0.1.0] - 2026-10-29

The first public release of SandLane. Release artifacts include the source archive, an installable
`purefect-sandlane-0.1.0.tgz`, its `SHA256SUMS`, and multi-architecture runtime, Relay, Qwen Code,
and OpenCode images:

- `ghcr.io/purefect-labs/purefect-sandlane-runtime:0.1.0`
- `ghcr.io/purefect-labs/purefect-sandlane-relay:0.1.0`
- `ghcr.io/purefect-labs/purefect-sandlane-qwen-code:0.1.0`
- `ghcr.io/purefect-labs/purefect-sandlane-opencode:0.1.0`

### Added

- A self-hosted execution plane that claims leased Runs from a control plane and executes them in
  ephemeral, resource-bounded Docker sandboxes.
- Built-in Codex, Claude Code, Qwen Code, and OpenCode Harness Drivers with normalized streaming,
  tool activity, cancellation, usage, and terminal events.
- Run-scoped model and tool capabilities that keep provider keys and user tokens in the trusted
  Worker, with isolated Relay paths to TLS model and MCP gateways.
- Public runtime, managed runtime, control-plane, Harness, model-upstream, ToolProvider, and
  SandboxProvider extension contracts, plus a Purefect reference integration.
- Responses and Anthropic Messages model paths, including verified DeepSeek text and MCP smoke
  tests with all four built-in CLIs.
- HTTP and stdio MCP upstream adapters, a reusable business SDK MCP template, and per-binding
  tenant/user credential selection.
- Credential-free Docker demos for success, cancellation, and lease-loss paths, plus an optional
  interactive real-model demo.
- Multi-architecture runtime and Relay container publication with SBOM and provenance attestations.

### Known limitations

- The bundled sandbox is a Docker container, not a microVM security boundary. Stronger isolation
  requires a custom `SandboxProvider` and target-environment validation.
- Public CI validates simulated CLI/model Docker fixtures. It does not certify real providers,
  native CLI versions, or a production Purefect deployment.
- Four Harness Drivers are bundled. Other CLIs require an adapter, a pinned image, and protocol
  compatibility testing.
- The package is distributed as source and as a GitHub Release tarball; it is not published to the
  npm registry.
- The managed runtime API is experimental and may change between `0.x` releases.

[Unreleased]: https://github.com/purefect-labs/purefect-sandlane/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/purefect-labs/purefect-sandlane/releases/tag/v0.1.0
