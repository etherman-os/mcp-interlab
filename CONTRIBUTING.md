# Contributing to MCP Interlab

Thank you for helping turn MCP interoperability failures into small, reproducible test cases. Contributions are welcome across the runner, diff engine, minimizer, CLI, documentation, and regression corpus.

## Development setup

You need Node.js `>=22.13.0` and pnpm `11.12.0`.

```bash
git clone https://github.com/YOUR_ACCOUNT/mcp-interlab.git
cd mcp-interlab
npm install --global pnpm@11.12.0
pnpm install --frozen-lockfile
pnpm check
```

Useful commands:

```bash
pnpm typecheck                 # TypeScript checks for every package
pnpm test                      # Vitest suite
pnpm build                     # Build the core package and CLI
pnpm check                     # typecheck + test + build
pnpm interlab corpus list      # Parse and validate the local corpus
pnpm interlab run examples/matrix.yml
```

The demo run exits with code `1` by design because its fixture profiles diverge. Use `pnpm check` as the normal green validation command.

Repository structure:

```text
packages/cli       command-line interface
packages/core      config, runner, diff, reports, artifacts, minimizer
corpus             shareable YAML interoperability cases
examples           local matrix and deterministic reference server
```

## Change workflow

1. Open an issue first for changes that alter the corpus format, artifact format, comparison semantics, or CLI interface. Small fixes do not require an issue.
2. Create a focused branch from the current default branch.
3. Add or update tests for observable behavior. Prefer deterministic fixtures; tests must not depend on an upstream `latest` image or a public network service.
4. Run `pnpm check` and any relevant end-to-end matrix locally.
5. Open a pull request explaining the behavioral problem, the chosen fix, and the verification performed.

Keep unrelated formatting and dependency changes out of a functional pull request. Do not commit generated `dist/` output, local run artifacts, credentials, or target logs.

## Contributing a regression case

The corpus is most useful when each case is evidence-backed, minimal, deterministic, and readable without access to a private system.

### 1. Establish the divergence

Reproduce the same ordered operation sequence against at least two named implementation or version targets. Record:

- SDK/server names and exact versions or commit SHAs;
- negotiated MCP protocol versions;
- the smallest known operation sequence;
- whether the difference is required by the specification, an implementation regression, or intentionally differential behavior;
- a public specification, changelog, or upstream issue URL.

For suspected security vulnerabilities, stop here and follow [SECURITY.md](SECURITY.md). Do not add a public fixture before coordinated disclosure.

### 2. Create the case

Place the fixture under the category that best describes the observation:

```text
corpus/protocol/
corpus/schema/
corpus/result-shape/
corpus/error-semantics/
```

Use a stable, descriptive ID and original test data:

```yaml
version: 1
id: descriptive-regression-id
title: One sentence describing the invariant
description: What differs and why a maintainer should care.
expectation: regression
tags: [tools, sdk-name]
category: result-shape
sources:
  - url: https://github.com/owner/project/issues/123
    note: Original report and maintainer discussion.
operations:
  - { id: discover, method: tools/list }
  - id: reproduce
    method: tools/call
    params:
      name: example_tool
      arguments: { value: minimal }
compare:
  ignorePaths: []
  unorderedPaths: []
```

The supported operation methods are `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`. Operation IDs must be unique within the case.

Choose `expectation` deliberately:

- `spec`: a control or behavior with a clear specification expectation;
- `differential`: a meaningful difference without a settled canonical result;
- `regression`: behavior known to have changed or violated an established invariant.

Choose a category only when the classification is known: `protocol`, `schema-acceptance`, `result-shape`, `error-semantics`, `lifecycle`, or `timeout`. If omitted, the runner infers a category from the observed difference.

### 3. Normalize narrowly

Comparison is strict by default. Add an `ignorePaths` rule only for a field that is demonstrably volatile and irrelevant to the invariant. Add an `unorderedPaths` rule only when order is contractually meaningless.

Paths use JSON Pointer syntax against the comparable target run, for example:

```yaml
compare:
  ignorePaths:
    - /observations/*/value/meta/requestId
  unorderedPaths:
    - /observations/1/value/structuredContent/items
```

`*` matches one token and `**` matches any remaining depth. Never use a broad ignore rule merely to make a case pass; reviewers must be able to explain every ignored path.

### 4. Minimize and validate

Include the case in a local matrix, run it, and use the generated artifact as the minimizer input:

```bash
pnpm interlab run path/to/matrix.yml --case descriptive-regression-id -o results/case.json
pnpm interlab minimize results/case.json --matrix examples/matrix.yml -o results/case.min.yml
pnpm interlab corpus list
pnpm check
```

The first command exits `1` when it reproduces the intended divergence. Copy the reviewed minimal operations back into the corpus fixture; do not commit the temporary artifact or minimization history.

### Corpus acceptance checklist

A corpus pull request should satisfy all of the following:

- The difference reproduces against exact, named targets and remains deterministic across repeated runs.
- A regression fixture has at least one public primary source such as the MCP specification or an upstream issue.
- The case contains the minimum operations and input needed to preserve the same difference category.
- Assertions come from observable MCP behavior, not target-specific stdout text.
- Fixture data is original or license-compatible with MIT redistribution and includes no copied proprietary payloads.
- Secrets, authorization headers, personal data, internal URLs, and customer content have been removed.
- The pull request describes the expected baseline/candidate difference and includes a redacted terminal or Markdown report.

If real targets cannot be made public, contribute a minimal clean-room fixture server profile that reproduces the protocol behavior and explain how it maps to the public source.

## Design principles

- Preserve wire truth. Do not silently discard payload fields because their names look volatile.
- Keep comparison deterministic. LLM judgments do not belong in the core equivalence predicate.
- Distinguish target failures from behavioral differences. Harness errors use exit code `2`; divergences use exit code `1`.
- Reproduce before reducing. A minimized case must preserve the same target pair, category, and relevant operation-status pattern on fresh processes.
- Keep versioned artifacts backward-readable whenever practical. Format changes require explicit migration and compatibility tests.

## Reporting bugs

Use the bug report issue form and attach the smallest matrix, case, and redacted artifact that reproduce the problem. A matrix can execute arbitrary commands, and artifacts retain MCP payloads, target logs, errors, and optional HTTP transcripts, so inspect every attachment before publishing it.

Please use [private vulnerability reporting](SECURITY.md) for command execution, process isolation, credential exposure, denial-of-service, or other security-sensitive findings.

## License

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE). You must have the right to contribute all code, fixtures, and documentation in your submission.
