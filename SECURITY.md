# Security policy

MCP Interlab starts local commands, connects to MCP endpoints, sends case-defined inputs, and stores server responses and process logs. Security reports are welcome, especially for command/process isolation, credential disclosure, unsafe artifact handling, denial of service, or cases where configured scope is escaped.

## Supported versions

MCP Interlab is currently experimental and has not declared a stable release line.

| Version                                      | Security support      |
| -------------------------------------------- | --------------------- |
| Current default branch                       | Yes                   |
| Older commits, forks, and unpublished builds | No guaranteed support |

This policy will be updated when versioned releases have a defined support window.

## Report a vulnerability privately

Do not open a public issue, pull request, or corpus fixture for a suspected vulnerability.

Use this repository's [private vulnerability reporting form](../../security/advisories/new). If private reporting is unavailable, contact the maintainer through their GitHub profile and request a private communication channel without including exploit details in the public message.

Please include:

- the affected commit or version and operating system;
- the relevant matrix/case shape with all secrets removed;
- impact and realistic attack preconditions;
- a minimal reproduction or proof of concept;
- whether the issue is already public or has been reported elsewhere;
- any suggested mitigation or disclosure constraints.

The maintainer will aim to acknowledge a complete report within seven days, keep the reporter informed while it is investigated, and coordinate publication after a fix or mitigation is available. Timelines can vary for early-stage software and cross-project MCP issues.

## Operational safety

Until the project gains stronger isolation and redaction controls, treat its inputs and outputs as security-sensitive:

- **Trust matrix files like shell scripts.** A target's `command`, `args`, `cwd`, and `env` are executed with the current user's privileges. Do not run matrices from an untrusted pull request or downloaded corpus without review.
- **Use disposable credentials and environments.** Managed targets receive a small runtime-variable allowlist, plus variables named in `inheritEnv` and values in `env`; this reduces accidental exposure but is not process isolation. Run third-party implementations in an external sandbox or container that you control.
- **Inspect artifacts before sharing.** JSON artifacts retain MCP observations, serialized errors, server stdout, and server stderr; targets with `recordHttp: true` also retain HTTP transcripts with per-body caps. Sensitive-looking headers are redacted and stored target/transcript URLs omit credentials and query strings, but request/response bodies, target output, and tool results can still contain secrets or personal data.
- **Assume cases can be destructive.** A `tools/call` operation invokes the real target. Point testing at isolated fixture servers, not production systems or accounts.
- **Constrain remote endpoints.** A matrix can direct the runner to arbitrary URLs. Apply network isolation when evaluating untrusted targets or cases.
- **Limit resource exposure.** Timeouts and log caps reduce accidental hangs and output growth, but they are not a hardened denial-of-service boundary.

Repository CI should use only deterministic, reviewed local fixtures. Public-network targets, live credentials, and unsandboxed commands introduced by untrusted contributions must not be added to normal pull-request workflows.

## Scope notes

The following usually belong in a public bug report rather than a private security report:

- an incorrect structural diff without confidentiality or integrity impact;
- a false-positive divergence or minimization quality problem;
- documented lack of stdio, authentication, or protocol feature coverage;
- a vulnerability that exists entirely in a tested third-party MCP target and is not caused or amplified by MCP Interlab.

When in doubt, report privately. The maintainer can redirect the issue after reviewing it.
