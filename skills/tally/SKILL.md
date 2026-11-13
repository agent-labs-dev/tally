---
name: tally
description: Track a repository's API keys by metadata, check which keys expire soon, record a rotation, declare a new key, or set up scheduled key-expiry issues with the tally CLI. Use when a key is expiring or expired, when reviewing whether every key is registered, current and set to expire where the provider allows, after replacing a key, when a workflow uses a secret nobody declared, when a new key needs its owner, locations, limit and expiry written down, or when a repository should watch expiries daily. tally holds metadata only: it never reads, stores or prints a value.
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
workflow, env template or secret store holds but nobody declared, a declared Actions secret no workflow reads, a
stored value unchanged for `staleDays`, a declared secret its store no longer holds, or a key its provider has not seen
used in `idleDays`. Exit 0 means nothing needs doing
today. Exit 1 is an error and exit 2 is wrong usage.

For an expiry finding, tell the user the key id, the expiry date, the owner and the runbook. For `unregistered`, including a
secret found in a store, the documented fix is to add the entry, or to list the name under `ignore` when it is not a credential. For `unused`, ask
the owner before revoking: say that Actions secrets are only readable by workflows, so it is likely unused.
For `stale`, tell the owner the date the stored value last changed and ask them to rotate it, then record the new
expiry with `tally rotated`. For `missing`, the secret was deleted or renamed in its store: ask the owner which, then
remove the location or restore the secret. For `idle`, tell the owner the last-used date and ask whether anything still
needs the key before revoking it. A `no-expiry` or `no-limit` gap means the provider itself reports none: suggest
setting one at the provider.

Do not decide on your own that a key is unused or safe to revoke. Ask the owner named in the entry.

After a key is replaced, record it:

```sh
tally rotated ID --expires YYYY-MM-DD
```

The new date is what future checks warn on. Without it the key keeps its old expiry and the issue stays open.

## Reviewing every key

Run this when asked whether keys are up to date or expire properly, and on a schedule. `check` reports only what
the file and its sources can show, so a clean `check` proves nothing while the file misses a key or a fact. Work
through these in order. Each one is done when its criterion holds for every entry:

1. **Coverage.** Every store tally can read that holds this file's keys is a `source`, and `tally check` reports no
   `unregistered`. A store tally cannot read, such as a dotfile or another vault, has no source: list what it holds
   by hand and confirm each item has an entry. A `filter` narrows the listing in that store's own syntax, so make sure
   it still covers everything the file owns. For a `pass` or `aws` source the filter is a name prefix: one that names
   a single entry hides the rest of the store, so list one source per owned prefix. Leave a part of a store out only
   when another tally file declares it, and name that file in a comment.
2. **Facts.** No `unknown-*` gap remains. Look each fact up in the provider's dashboard or key settings. Where
   only the owner can see it, ask them and leave `unknown` until they answer.
3. **Expiry where offered.** Every `expires: none` has an `expiresNote` naming where that was confirmed and when.
   Re-read the provider's current key docs for each one without that. When the provider does offer an expiry, the
   key gets a date: mint a replacement with one, and record it with `tally rotated ID --expires YYYY-MM-DD`. Use the
   shortest lifetime the key's runbook allows, and one year when nothing says otherwise. A short-lived token that a
   tool re-mints stays `none`, and its note names the longer-lived credential that lapses instead.
4. **Limit where offered.** Every `limit: none` is a provider with no cap. Where the provider offers one, set it
   there first, then write `hard` or `soft` and the amount.
5. **Freshness.** `stale`, `idle` and `unused` findings are each a question put to the owner, as described above.

The review is done when `tally check` exits 0 with no gap findings, or when each remaining gap is a question the
owner has been asked. Report the keys you changed and the questions still open.

## Setting up a repository

```sh
tally init --owner HANDLE
```

This writes `.tally.yaml` with one draft entry per secret the workflows use, each with `service: unknown`,
`expires: unknown` and `limit: unknown`. On an existing file it only adds: new locations onto the entry that names the
same secret, and new entries for the rest, so run it again after adding `sources:`. Then fill in the facts from the provider dashboard, and run `tally validate`
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
