# MCP Interlab

**Find the behavioral difference between MCP implementations, then reduce it to a case someone can actually fix.**

[![CI](https://github.com/etherman-os/mcp-interlab/actions/workflows/ci.yml/badge.svg)](https://github.com/etherman-os/mcp-interlab/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP Interlab runs the same declarative MCP session against two or more live servers, compares their observable behavior, and emits a reproducible artifact. When it finds a divergence, its minimizer repeatedly reruns the relevant target pair to remove unrelated operations and simplify tool arguments while preserving the failure class.

> [!IMPORTANT]
> MCP Interlab is an experimental `0.1.0` project. The CLI currently runs from a source checkout and supports MCP **servers over Streamable HTTP**. See [Current limitations](#current-limitations) before using it in a production workflow.

## Why another MCP testing tool?

MCP Interlab answers a different question from conformance and record/replay tools:

| Tool category                                                                             | Reference point                        | Primary question                                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Official MCP conformance framework](https://github.com/modelcontextprotocol/conformance) | Specification-defined checks           | Does this client or server satisfy the tested parts of the MCP specification?                                  |
| Record/replay tools such as [mcp-recorder](https://github.com/devhelmhq/mcp-recorder)     | A previously captured cassette         | Did this server change relative to recorded traffic?                                                           |
| **MCP Interlab**                                                                          | Another live implementation or version | Do these targets behave differently for the same session, and what is the smallest input that demonstrates it? |

These approaches complement one another. Conformance gives an authoritative expected behavior where the specification and checks are explicit. Record/replay protects a known contract. MCP Interlab is useful at SDK, server-version, and protocol-version boundaries where implementations can accept the same exchange but expose different result shapes, error semantics, lifecycle behavior, or timeouts.

It is deliberately not an LLM-based judge. Comparison is deterministic and structural:

- The first target in a matrix is the baseline; every later target is compared with it.
- Execution duration, target logs, URLs, and server identity are retained in artifacts but excluded from behavioral comparison.
- Payload fields remain meaningful by default. Volatile fields and unordered arrays are ignored only through explicit JSON Pointer rules.
- Every run produces a JSON artifact containing its case results, with terminal, JSON, and Markdown renderers.
- Minimization preserves the target pair, divergence category, first diff fingerprint, process health, and operation status pattern. It verifies the original and minimized failure on fresh processes. When the baseline run includes a successful `tools/list`, minimization also preserves the original schema-validity outcome.

## Sixty-second demo

Prerequisites: Node.js `>=22.13.0` and pnpm `11.12.0`.

```bash
npm install --global pnpm@11.12.0
pnpm install --frozen-lockfile
pnpm build

pnpm interlab run examples/matrix.yml --output results/demo.json
```

The bundled matrix launches two local Streamable HTTP fixture profiles. One returns a search result and the other silently returns an empty list. The demo intentionally exits with status `1` because it finds this divergence (the run ID, second diff entry, and artifact path are omitted below):

```text
MCP Interlab

1 case(s): 0 equivalent, 1 divergent, 0 harness error(s)

CASE search-empty-regression — Successful search unexpectedly returns no items
  baseline: completed (interlab-reference-baseline@0.1.0), 10 operation(s)
  candidate: completed (interlab-reference-candidate@0.1.0), 10 operation(s)
  ✗ REGRESSION FOUND: baseline ≠ candidate [result-shape]
    changed      /observations/9/value/content/0/text
      baseline: "{\"items\":[{\"title\":\"typescript\",\"rank\":1}]}"
      candidate: "{\"items\":[]}"
```

Now minimize the ten-operation session and render a shareable report:

```bash
pnpm interlab minimize results/demo.json --matrix examples/matrix.yml --output results/demo.min.yml
pnpm interlab report results/demo.json --format markdown > results/demo.md
```

The minimizer produces a standalone corpus case like this:

```yaml
version: 1
id: search-empty-regression
title: Successful search unexpectedly returns no items
expectation: regression
tags: [tools, minimizer, demo]
category: result-shape
sources: []
operations:
  - id: search
    method: tools/call
    params:
      name: search
      arguments: { query: a, limit: 1 }
compare: { ignorePaths: [], unorderedPaths: [] }
```

### Opt-in cross-SDK example

[`examples/sdk-matrix.yml`](examples/sdk-matrix.yml) is a real implementation-to-implementation differential. It runs pinned official TypeScript SDK `1.29.0` and Python SDK `1.27.2` FastMCP servers:

```bash
# Requires uv: https://docs.astral.sh/uv/
pnpm interlab run examples/sdk-matrix.yml --output results/sdk-matrix.json
```

The TypeScript dependency is pinned in the workspace. The Python server uses PEP 723 inline metadata to pin `mcp==1.27.2`; its first `uv` run requires network access to populate the local package cache. The matrix intentionally exits `1`: its semantic-output case is equivalent, while its capability-advertisement case preserves an observed protocol difference.

```text
2 case(s): 1 equivalent, 1 divergent, 0 harness error(s)

CASE official-sdk-structured-output — Official TypeScript and Python SDKs return equivalent structured content
  typescript-sdk-1.29.0: completed (interlab-typescript-sdk@1.29.0), 1 operation(s)
  python-sdk-1.27.2: completed (interlab-python-sdk@1.27.2), 1 operation(s)
  ✓ typescript-sdk-1.29.0 = python-sdk-1.27.2

CASE official-sdk-capability-advertisement — Official TypeScript and Python SDKs advertise different capabilities
  ✗ DIFFERENCE FOUND: typescript-sdk-1.29.0 ≠ python-sdk-1.27.2 [protocol]
```

Both cases live under `examples/cases/`, not the public regression corpus. The structured-output case ignores initialization, text rendering, and the Python SDK's explicit `isError: false`, then compares the negotiated protocol, operation status, and `structuredContent`. The protocol case ignores operation observations and shows the actual initialization difference: TypeScript advertises `tools.listChanged: true`, while Python advertises it as `false` and includes empty `prompts`, `resources`, and `experimental` capabilities. This is an observed differential, not a claim that either SDK is wrong or a broad certification of either SDK.

## How it works

```text
matrix.yml + corpus cases
          |
          v
 start or connect to 2+ Streamable HTTP targets
          |
          v
 run the same ordered MCP operations on every target
          |
          v
 normalize explicit paths -> baseline/candidate structural diff
          |
          +--> JSON artifact -> terminal / JSON / Markdown report
          |
          `--> fresh-process reruns -> minimal reproducer YAML
```

Each case gets fresh managed target processes. Targets within a case run concurrently; cases in a matrix run sequentially. Managed process stdout and stderr are capped and saved in the artifact. Cleanup targets the process group on POSIX and the direct child on Windows, where descendant cleanup remains best-effort.

## Define a target matrix

A matrix contains at least two targets and one or more inline or referenced cases. Relative target working directories and case paths are resolved from the matrix file.

```yaml
version: 1
targets:
  sdk-v1:
    command: node
    args: [servers/sdk-v1.mjs, --port, '43101']
    cwd: .
    url: http://127.0.0.1:43101/mcp
    recordHttp: true
    maxResponseBytes: 4194304
    startupTimeoutMs: 10000
    requestTimeoutMs: 5000
    shutdownTimeoutMs: 2000

  sdk-v2:
    command: node
    args: [servers/sdk-v2.mjs, --port, '43102']
    cwd: .
    env:
      LOG_LEVEL: error
    inheritEnv: [SDK_API_TOKEN]
    url: http://127.0.0.1:43102/mcp
    recordHttp: true

cases:
  - ../corpus/result-shape/structured-output.yml
```

Omit `command` to connect to an already running target. Managed targets receive a small cross-platform allowlist of runtime environment variables plus explicit `inheritEnv` names and `env` values. `maxResponseBytes` defaults to 4 MiB and rejects oversized declared or streamed MCP responses before the SDK materializes them. Set `recordHttp: true` per target to retain an HTTP transcript with scrubbed URLs/headers and capped bodies; recording is off by default. Because matrix files can launch arbitrary commands, only run matrices you trust.

Target order matters: `sdk-v1` is the baseline in this example, and every subsequent target is compared with it.

## Write a corpus case

Cases are YAML or JSON documents with an ordered operation list and explicit comparison rules:

```yaml
version: 1
id: structured-output-example
title: Structured output survives serialization
description: Detects a target that drops structuredContent.
expectation: regression
tags: [tools, structured-content]
category: result-shape
sources:
  - url: https://github.com/modelcontextprotocol/typescript-sdk/issues/2464
operations:
  - { id: discover, method: tools/list }
  - id: call
    method: tools/call
    params:
      name: structured_probe
      arguments: {}
compare:
  ignorePaths:
    - /observations/*/value/meta/requestId
  unorderedPaths:
    - /observations/1/value/structuredContent/items
```

Supported operations are:

- `tools/list` and `tools/call`
- `resources/list` and `resources/read`
- `prompts/list` and `prompts/get`

`ignorePaths` and `unorderedPaths` use JSON Pointer syntax rooted at the comparable target observation. `*` matches one path token and `**` matches any remaining depth. Arrays remain ordered unless their exact path is listed under `unorderedPaths`.

The `expectation` field (`spec`, `differential`, or `regression`) documents why a case exists; it does not change comparison behavior. Optional divergence categories are `protocol`, `schema-acceptance`, `result-shape`, `error-semantics`, `lifecycle`, and `timeout`.

The repository includes ten seed cases covering control behavior, schema acceptance, result shape, error semantics, explicit unordered-array normalization, and minimization. List and validate them with:

```bash
pnpm interlab corpus list
pnpm interlab corpus list --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md#contributing-a-regression-case) for the evidence, minimization, and licensing requirements for corpus contributions.

## CLI

```text
mcp-interlab run <matrix> [--case <id>] [--format terminal|json|markdown] [-o <artifact>]
mcp-interlab report <artifact> [--format terminal|json|markdown]
mcp-interlab minimize <artifact> --matrix <trusted-matrix> [--case <id>] [-o <case.yml>]
mcp-interlab corpus list [--dir <path>] [--json]
```

From a repository checkout, prefix these commands with `pnpm interlab` as shown in the demo.

`run` always writes a versioned JSON artifact. If `-o` is omitted, it uses `results/run-<timestamp>-<id>.json`. Artifacts include the checksummed matrix source, case definitions, normalized diff entries, per-target observations, negotiated protocol versions, process status, and capped target logs. Targets with `recordHttp: true` also include HTTP transcripts with scrubbed URLs/headers and per-body caps. Payload bodies are not a general-purpose secret-redaction boundary. Because matrices execute commands, `minimize` always requires an explicit trusted `--matrix`; it rejects checksum drift unless `--allow-matrix-change` is passed after reviewing the file.

### Exit codes

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | All compared targets were equivalent, or a non-run command completed successfully. |
| `1`  | `run` found at least one behavioral divergence.                                    |
| `2`  | Configuration, startup, connection, process, or other harness failure.             |

Harness errors take precedence over behavioral divergence for the suite exit code.

## Current limitations

The current implementation is a focused, testable core—not the complete compatibility lab envisioned for later releases:

- Streamable HTTP server targets only; stdio targets and MCP client testing are not implemented.
- `recordHttp: true` can attach a URL/header-scrubbed, per-body-capped HTTP transcript to a run artifact, but there is no transparent proxy recording, cassette replay, mock server, or import from recorder formats.
- No OAuth, custom HTTP headers, secrets provider, sampling, roots, completions, subscriptions, notifications, or multi-turn LLM behavior.
- One opt-in two-case TypeScript/Python cross-SDK differential is included, but there are no bundled Docker images, multi-version SDK suite, or maintained compatibility matrix yet.
- The seed corpus is a set of executable fixtures and source-linked probes, not a claim that every listed regression has been reproduced across every official SDK.
- Minimization reduces session operations and common `tools/call` argument shapes only when both selected target runs complete and the divergence has an operation-level diff fingerprint. It does not yet reduce startup/connection/crash-only failures, generate schema-derived mutations, or recursively minimize every JSON scalar.
- Comparisons are baseline-to-candidate, not all-pairs, and intentionally use structural equality rather than natural-language semantic similarity.
- There is repository CI, but no reusable `mcp-interlab` GitHub Action, PR-comment bot, hosted service, or web UI.
- POSIX cleanup terminates the managed process group; Windows cleanup is currently best-effort and may not stop descendants launched by wrapper commands.
- The npm package metadata is prepared, but this README does not assume a package has been published.

## Contributing and security

Bug fixes, new target adapters, clearer diagnostics, and well-sourced minimal corpus cases are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and use the issue forms when proposing a regression case or reporting a reproducible bug.

Matrix files execute commands and run artifacts can contain MCP payloads and target logs. Do not publish secrets. Report security issues through the private process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
