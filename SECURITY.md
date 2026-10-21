# Security Policy

## Reporting a vulnerability

Report privately. Do not open a public issue for a suspected vulnerability.

**Preferred:** [Report a vulnerability](https://github.com/opena2a-org/ai-trust/security/advisories/new)
via GitHub private vulnerability reporting. It is enabled on this repository and the report stays
private until an advisory publishes.

**Alternative:** info@opena2a.org

Please include:

- What you observed, and the command that produced it
- Steps to reproduce, including the version (`ai-trust --version`)
- What you expected instead
- Any output you are willing to share, with credentials removed

**Do not send us real credentials.** If a report involves a credential, redact it and describe its
shape (vendor prefix and length) rather than pasting the value. If you believe one of your own
credentials was exposed by this tool, rotate it first, then report.

We acknowledge receipt within 48 hours and give a remediation timeline in that reply.

## Scope

This policy covers `ai-trust`: the CLI, its published npm package, and this repository. Other
repositories in the [opena2a-org](https://github.com/opena2a-org) organization have their own
policies, including [HackMyAgent](https://github.com/opena2a-org/hackmyagent), the scanner this
tool runs for local scans.

Reports about a *checked package* (a package this tool reports on) should go to that project, not
to us. Reports about how this tool **handles** what it downloads, scans or receives from the
registry, including anything it writes into its own output, are in scope here.

## Scanning this repository

`hackmyagent secure . --ci --no-registry --no-contribute --format json`, run from the repository
root with the `hackmyagent` 0.33.2 that `package.json` pins, reports one failed check: MEDIUM
`AIM-001` ("Agent project has no identity declaration file") on `package.json`, with a score of
95/100. The check fires when no `agent-card.json`, `agent.json` or `aim.json` (at the root or under
`.well-known/`) exists and a `package.json` keyword contains `agent` or `a2a`.

Trigger keywords: `a2a`, `ai-agent`, `opena2a`

The finding does not apply to this repository. `ai-trust` is a command-line tool that queries the
registry and runs the scanner locally; it is not an agent. Its source starts no server and
publishes no agent card, so there is no identity for another agent or a registry to verify, and a
declaration file would describe an identity that does not exist. The keywords stay because they
name what the tool checks. No suppression is configured for the finding: it stays in the scanner's
output, and this section records why it is left open. Revisit it if `ai-trust` starts serving
requests or taking part in an agent-to-agent exchange.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.7.x   | Yes       |
| < 0.7   | No        |

Fixes land on the latest published minor. Upgrade to the current release before reporting, and say
which version you reproduced on.

## Disclosure

We publish a GitHub Security Advisory for defects that affect users of the published package, and
request a CVE where one applies. Advisories publish once a fixed version is installable from npm, so
that the advisory and its remedy arrive together. We credit reporters who want credit.
