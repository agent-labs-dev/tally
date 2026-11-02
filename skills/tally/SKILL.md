---
name: tally
description: Track a repository's API keys by metadata, check which keys expire soon, record a rotation, declare a new key, or set up scheduled key-expiry issues with the tally CLI. Use when a key is expiring or expired, after replacing a key, when a workflow uses a secret nobody declared, when a new key needs its owner, locations, limit and expiry written down, or when a repository should watch expiries daily. tally holds metadata only: it never reads, stores or prints a value.
---

# tally

A repository declares its keys in `.tally.yaml` at its root: owner, where each value is stored, its limit and its
expiry. The file is metadata only, so the same steps work for an Actions secret, an environment secret, a password
store item, a dotfile and any other store.

Start with the findings:

```sh
tally check --json
```

Exit code 3 means there are `action` findings: an expired key, one expiring inside the warning window, a secret a
workflow reads but nobody declared, or a declared Actions secret no workflow reads. Exit 0 means nothing needs doing
today. Exit 1 is an error and exit 2 is wrong usage.

For an expiry finding, tell the user the key id, the expiry date, the owner and the runbook. For `unregistered`, the
documented fix is to add the entry, or to list the name under `ignore` when it is not a credential. For `unused`, ask
the owner before revoking: say that Actions secrets are only readable by workflows, so it is likely unused.

Do not decide on your own that a key is unused or safe to revoke. Ask the owner named in the entry.

After a key is replaced, record it:

```sh
tally rotated ID --expires YYYY-MM-DD
```

The new date is what future checks warn on. Without it the key keeps its old expiry and the issue stays open.

## Setting up a repository

```sh
tally init --owner HANDLE
```

This writes `.tally.yaml` with one draft entry per secret the workflows use, each with `service: unknown`,
`expires: unknown` and `limit: unknown`. Then fill in the facts from the provider dashboard, and run `tally validate`
and `tally check`.

To declare a key that no workflow uses yet, use `tally add` with flags. It writes metadata only; there is no prompt and
no way to pass a value.

```sh
tally add ID --service S --owner O --location github:SECRET_NAME \
  --expires YYYY-MM-DD --limit '1000 requests per minute' --runbook docs/rotate.md
```

Locations: `github: NAME` for this repository, `github: env:ENV/NAME` for an environment secret,
`github: OWNER/REPO/NAME` for another repository, and any other kind for a store the scan does not check.

Never ask for, read or paste a key value, a fragment of one, or anything that looks like one. Location references are
paths and secret names, not secrets. If a user pastes a value, do not write it anywhere, do not repeat it, and tell
them to rotate it, because it is now in the transcript.

## Scheduling it

In a repository, add a workflow that calls the composite action:

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

On a single machine, put the keys in `~/.config/tally/tally.yaml` and run this from a timer:

```sh
tally notify
```

It runs the same check and sends a desktop notification per action finding with `notify-send`, when that is installed.
Its exit codes are the same as `check`, so a wrapper can act on code 3.

## What to read before acting

1. `tally schema` once, for the output contract, so automation parses findings rather than titles.
2. `tally check --json` on the schedule. Leave `gap` findings for a weekly summary, because a missing fact is not a
   deadline.
3. `tally list` to show the declared keys, `tally validate` after editing the file by hand, and `tally issues sync`
   when the user wants issues to match the current findings.

A gap finding means nobody has looked up a fact. Fill it in; do not guess. `expires: none` needs a written reason in
`expiresNote`.
