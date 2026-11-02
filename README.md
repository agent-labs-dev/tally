<img src="assets/logo.svg" alt="" width="96">

# tally

A registry of a repository's API keys, tokens and certificates: who owns each one, where it is stored, its limit and
when it expires. Every key is declared in one `.tally.yaml` at the repository root, and a scheduled workflow files an
issue before a key expires or when a workflow uses a secret nobody declared.

tally never reads, stores or prints a secret value. It records metadata only: names, locations, limits and dates. The
file is checked for credential-shaped text before it is written, and again every time it is validated.

Agents are the main users. Output is JSON when asked for it, and the exit codes say what to do next.

## Quick start

1. Draft the file from the secrets the repository already uses:

   ```sh
   tally init --owner owner-handle
   ```

   Every `${{ secrets.NAME }}` in `.github/workflows` becomes an entry with `service: unknown`,
   `expires: unknown` and `limit: unknown`.

2. Fill in the facts. Look each key up in the provider's dashboard and set `service`, `owner`, `locations`, `expires`
   and `limit`. If the provider sets no expiry, write `none` and say why in `expiresNote`.

3. Run `tally validate` and then `tally check`.

4. Add a workflow that keeps the issues in sync (see [Daily issues](#daily-issues)), or run it by hand:

   ```sh
   tally issues sync
   ```

## The `.tally.yaml` file

Settings and keys live in one file, so a repository declares everything in one place:

```yaml
warnDays: 30
issueRepo: owner/name
secretPatterns: []
ignore:
  - BUILD_ID
keys:
  - id: payments-api
    service: example-provider
    group: payments
    owner: owner-handle
    locations:
      - github: PAYMENTS_API_KEY
      - github: env:production/DEPLOY_KEY
      - github: owner/other-repo/SHARED_KEY
      - vault: kv/payments
    expires: 2027-01-01
    limit: $200/mo
    runbook: docs/rotate-payments.md
```

| Setting | Meaning |
|---|---|
| `warnDays` | A dated key raises an issue this many days before it expires. Default 30 |
| `issueRepo` | Where `issues sync` files issues. Default: `GITHUB_REPOSITORY`, else gh infers the repository from the cwd |
| `secretPatterns` | Extra credential regular expressions, added to the built-in guard |
| `ignore` | Secret names workflows reference that are not credentials, such as ids and URLs |
| `keys` | The entries, in reading order |

An entry has these fields:

| Field | Meaning |
|---|---|
| `id` | Lowercase words joined by hyphens, unique within the file |
| `service` | The provider or issuer, any slug, for example `example-provider` |
| `group` | Optional. Who uses it, any slug, for example `payments` or `personal` |
| `owner` | The lowercase GitHub handle responsible for rotating it, or `unknown`. Action issues are assigned to it |
| `locations` | Every place the value is stored, one per line |
| `expires` | `YYYY-MM-DD`, `unknown` (nobody has looked yet) or `none` (with a reason) |
| `expiresNote` | Why the date is what it is, or why there is none |
| `limit` | Free text such as `$200/mo`, `unknown` or `none` |
| `runbook` | Optional path or URL to your own rotation steps |
| `note` | Anything a person needs to know before rotating |

`label` and `fingerprint` are optional. `label` is the provider's own name for the key. `fingerprint` is the redacted
suffix the provider shows, at most 6 characters, which is enough to tell two keys apart without being useful to anyone
else.

Unknown top-level settings are errors, `expires: none` is rejected without an `expiresNote`, and two entries cannot
share an `id`. Nothing in the file may look like a credential: comments and quoting are scanned too, before parsing.

The file is discovered in this order:

1. `TALLY_CONFIG`, when set;
2. the nearest `.tally.yaml` walking up from the current directory, stopping at the directory that contains `.git`;
3. `$XDG_CONFIG_HOME/tally/tally.yaml`, defaulting to `~/.config/tally/tally.yaml`.

`--config PATH` overrides all three.

## Location conventions

The location kind is an open slug. Adding a new kind needs no code.

- `github: SECRET_NAME` for an Actions secret in this repository.
- `github: env:ENV/SECRET_NAME` for an environment secret in this repository.
- `github: OWNER/REPO/SECRET_NAME` for a secret in another repository, and
  `github: OWNER/REPO/env:ENV/SECRET_NAME` for another repository's environment secret.
- Any other kind is recorded but not scanned: `vault: kv/payments`, `file: ~/.config/app#TOKEN`.

One location per copy. A key copied into four repositories gets four lines, because one leak then needs every copy
rotated.

## What `check` reports

| Finding | Severity | Meaning |
|---|---|---|
| `expired`, `expiring` | action | The date has passed, or is inside `warnDays` |
| `unknown-expiry`, `unknown-limit` | gap | Nobody has looked yet. The gaps share one digest issue |
| `unregistered` | action | A workflow reads a secret no entry declares in this repository |
| `unused` | action | An entry declares an Actions secret no workflow reads |

The two scan findings stay quiet when there is no `.github/workflows` directory, because there is nothing to compare
against. A secret in another repository is never reported as unused. Names in `ignore` are never reported as
unregistered, and `GITHUB_TOKEN` is always skipped.

Exit codes:

| Exit code | Meaning |
|---|---|
| 0 | Nothing to do |
| 1 | An error: bad file, unreadable path, or `gh` failed |
| 2 | Wrong usage |
| 3 | Action findings |

Gap findings never change the exit code. They appear in the output and in the digest issue.

## Commands

```sh
tally init [--owner HANDLE]        # write .tally.yaml, drafted from the repository's workflows
tally check [--today DATE]         # expiring keys, missing facts and scan findings
tally notify [--today DATE]        # check, then a desktop notification per action finding
tally list [--group G] [--service S]
tally validate                     # parse the file and report every error
tally add ID --service S --owner O --location KIND:REF [--location ...]
tally rotated ID --expires DATE
tally issues sync [--repo OWNER/NAME] [--dry-run]
tally schema                       # the CLI contract: fields, commands and exit codes
```

`add` takes the whole entry on the command line and writes metadata only. It creates the file if it is missing:

```sh
tally add payments-api \
  --service example-provider --group payments --owner owner-handle \
  --location github:PAYMENTS_API_KEY \
  --location vault:kv/payments \
  --expires 2027-01-01 --limit '$200/mo' \
  --runbook docs/rotate-payments.md
```

`--expires` and `--limit` default to `unknown`, which `check` reports as a gap. `tally rotated` clears the old
`expiresNote` and records the date you pass, so the new expiry is the one future checks warn on. Global flags are
`--config PATH` and `--json`.

## Daily issues

- Each action finding gets one issue, labelled `tally` plus its kind (`tally:expired`, `tally:unregistered`). The id
  is stable, so the same issue is edited as a key moves from "expires in 20 days" to "expired".
- Each issue for an entry is assigned to that entry's `owner` after it is created. When gh rejects the owner, the
  issue stays unassigned; a failed create is never retried, so a finding never gets two issues.
- Every gap finding shares one digest issue listing the keys with no recorded expiry or limit.
- When a finding clears, its issue is closed with a comment. No finding, no issue.

Put this in `.github/workflows/tally.yml` in any repository that declares keys:

```yaml
on:
  schedule: [{ cron: "0 7 * * *" }]
  workflow_dispatch:
permissions: {}
concurrency: { group: tally-issues, cancel-in-progress: false }
jobs:
  tally:
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: write }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: OWNER/tally@v1
```

Replace `OWNER/tally@v1` with the repository that publishes this action. The workflow's own token is enough, so the
job needs `issues: write` and nothing else. The action's `config` input defaults to `.tally.yaml`, and it sets
`TALLY_CONFIG` for the run, so pass `config:` only to use another path.

## Local machine mode

Keys that live on one machine, and not in a repository, go in `~/.config/tally/tally.yaml` (or
`$XDG_CONFIG_HOME/tally/tally.yaml`). That path is used when no `.tally.yaml` is found.

With no `.github/workflows` directory the scan rules return nothing, so `tally check` only looks at the dates and facts
you recorded. `tally notify` runs the same check and sends a desktop notification for each action finding, using
`notify-send` when it is on `PATH`. A systemd user timer can run it daily:

```ini
# ~/.config/systemd/user/tally-notify.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/tally notify
```

```ini
# ~/.config/systemd/user/tally-notify.timer
[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user enable --now tally-notify.timer
```

Exit code 3 from `notify` means something needs rotating. A timer ignores it; a wrapper script can act on it.

## Extend it

- New providers, groups and secret stores are new entries or locations. There is no list of them in the code.
- New checks are `Rule` functions in `src/reconcile.ts`. A rule takes every entry plus the context and returns
  findings. It never writes. The default rules run expiry, limit and the two scan checks.
- Extra credential formats go in `secretPatterns`, as regular expression strings. They are added to the built-in
  guard, which rejects known provider prefixes and long random-looking tokens.
- Any other setting, such as `warnDays` or `issueRepo`, lives in the tally file.

## Develop

```sh
bun install --frozen-lockfile
bun run gate
```

`bun run gate` runs Biome, `tsc`, the tests, the changelog check and `tally validate`. To give an agent the workflow,
install the skill in [`skills/tally/SKILL.md`](skills/tally/SKILL.md).
