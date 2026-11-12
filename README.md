<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
  <img src="assets/wordmark.svg" alt="tally" width="300">
</picture>

</div>

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

   Every `${{ secrets.NAME }}` in `.github/workflows` and every credential-named variable in a tracked env template
   (`.env.example`, `.env.sample`, `.env.template`, `env.example`, `NAME.env.example`, `NAME.example.env`), including
   a commented-out `# NAME=` line for an optional key,
   becomes an entry with `service: unknown`, `expires: unknown` and `limit: unknown`. Only names are read: never a
   value, and never a real `.env`.

   Run it again after adding `sources:` or new secrets. It keeps every existing entry, adds a store copy or a new
   location to the one entry that already names that secret, and drafts entries only for secrets nobody declared.

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
| `staleDays` | A stored value unchanged for this many days is reported as stale. Default 365 |
| `idleDays` | A key its provider has not seen used for this many days is reported as idle. Default 90 |
| `sources` | Secret stores to read names and dates from. See [Secret stores](#secret-stores) |
| `issueRepo` | Where `issues sync` files issues. Default: `GITHUB_REPOSITORY`, else gh infers the repository from the cwd |
| `secretPatterns` | Extra credential regular expressions, added to the built-in guard |
| `ignore` | Names the scan finds that are not credentials, such as ids and URLs |
| `ignorePaths` | Globs for files both scans skip, such as test fixtures that name made-up secrets |
| `credentialNames` | Extra regular expressions for credential variable names in env templates. Built in: names ending in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `PAT`, `KEYSTORE`, `HOOK`, `DSN` or `CREDENTIALS` |
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
| `deletion` | action | A store is scheduled to delete a declared secret within `warnDays` |
| `unknown-expiry`, `unknown-limit`, `unknown-service`, `unknown-owner`, `org-owner` | gap | A fact is missing, or an organization owner cannot be assigned. The gaps share one digest issue |
| `no-expiry`, `no-limit` | gap | The entry records nothing, and its provider says the key never expires or has no spend limit |
| `unregistered` | action | A workflow or an env template names a secret no entry declares |
| `unused` | action | An entry declares an Actions secret no workflow reads |
| `stale` | action | A store says the value has not changed in `staleDays` |
| `missing` | action | An entry names a secret in a store that was read, and the store does not hold it |
| `idle` | action | Its provider has not seen the key used in `idleDays` |

A store that holds a secret no entry declares also reports it as `unregistered`.

A workflow secret is declared by a `github` location in this repository. A template variable is declared by any
location whose last segment is its name, such as `github: NAME`, `env: NAME` or `vault: kv/app/NAME`, because the
template does not say where the value is stored. The scans stay quiet outside a git checkout. A secret in another repository is never reported as unused. Names in `ignore` are never reported as
unregistered, and `GITHUB_TOKEN` is always skipped.

Exit codes:

| Exit code | Meaning |
|---|---|
| 0 | Nothing to do |
| 1 | An error: bad file, unreadable path, or `gh` failed |
| 2 | Wrong usage |
| 3 | Action findings |

Gap findings never change the exit code. They appear in the output and in the digest issue.

## Secret stores

The code says which keys exist. A secret store says when each value last changed, and sometimes when it expires.
`sources:` lists the stores to read, as `kind: scope` pairs:

```yaml
sources:
  - gcp: my-project
    filter: labels.app=web   # optional, in the store's own filter syntax
  - aws: eu-west-1
    filter: payments/        # optional name prefix
  - azure: my-vault
  - github: owner/name     # this repository's Actions and environment secrets
    filter: production     # optional: only these environments, comma-separated
  - github: my-org         # an organization's secrets
  - pass: local            # a local Unix pass store; the scope is only a label
    filter: wow/           # optional literal prefix of the entry names
```

| Kind | Scope | Reads | Changed date |
|---|---|---|---|
| `gcp` | project id | `gcloud secrets list`, `gcloud secrets versions list` | newest enabled version; `tally-*` annotations |
| `aws` | region | `aws secretsmanager list-secrets` | last rotation, else last change |
| `azure` | vault name | `az keyvault secret list` | last update |
| `github` | `OWNER/NAME` or an organization | `gh api` secret and environment listings | last update |
| `pass` | a label you choose | the password store's directory listing | modified time of the `.gpg` file |

tally runs each vendor's CLI with the login it already has. It runs only the listing commands above and refuses
anything else, so it never prints, sets or backs up a value. Give it a role that cannot read
values either: `roles/secretmanager.viewer` on GCP, `secretsmanager:ListSecrets` on AWS, and the `list` secret
permission on Azure.

### Unix pass

`pass: local` reads `PASSWORD_STORE_DIR`, else `~/.password-store`. It lists directories and the modified time of each
`.gpg` file, and nothing else: it never opens a file, runs `pass` or `gpg`, or decrypts. A missing or unreadable store
fails the run, while an empty one is simply empty. `.git` and `.extensions` at the top are skipped, nested entries
count, and a symlink under the root fails the run unread (the root itself may be one). `filter` is a literal prefix of
the entry name, without `.gpg`, and the label in `pass: LABEL` is only a name for locations.

Entry names, store labels and ignore entries are case-sensitive. A location is `pass: LABEL/wow/name` (or
`pass: wow/name`) and matches that entry exactly.
The changed date is when the ciphertext was last written, which is not proof of rotation: re-encrypting or touching
the file moves it. Owner, expiry and limit stay in `.tally.yaml`. A pass entry is storage only, so `init` never drafts
one or links it to another key by name; declare each by hand.

### Google Cloud annotations

Secret Manager holds the credential value. Its annotations can hold the metadata, so the facts live next to the key
and not in a file someone must remember to edit. tally reads these annotation keys and ignores every other one:

| Annotation | Fills |
|---|---|
| `tally-owner` | `owner` |
| `tally-service` | `service` |
| `tally-expires` | `expires`: a date, or `none` with a `tally-expires-note` |
| `tally-expires-note` | `expiresNote` |
| `tally-limit` | `limit` |
| `tally-runbook` | `runbook` |

```sh
gcloud secrets update PAYMENTS_API_KEY --project my-project \
  --update-annotations=tally-owner=team-payments,tally-expires=2027-03-01
```

Annotations go through the same checks as the file, so a malformed or credential-shaped one fails the run without
being echoed. They complete a `.tally.yaml` entry only where it says `unknown` (or has no `runbook`), so a value in the
file is an intentional override. Two annotations that disagree on owner, service, runbook or limit fail the run: record
the value in the file. For an unknown YAML expiry, the earliest observed credential expiry wins. A GCP
`tally-limit: none` records an intentional lack of a limit, just as `limit: none` in YAML does. Nothing is written back
to `.tally.yaml`.

A secret still needs an entry with a `gcp` location, which `tally init` drafts: an annotation alone does not declare a
key.

A secret's own `expireTime` removes the secret from Secret Manager, not the credential from its provider, so tally never
reads it as the key's expiry. It reports a `deletion` finding once that date is within `warnDays`, whatever the entry's
`expires` says. Secret Manager's rotation schedule is likewise only a Pub/Sub notification; it does not rotate the key
at its provider, so tally does not treat it as a rotation or an expiry.

GitHub never returns a secret value through its API, only names and dates. tally runs `gh api` only as an exact
listing command, so no extra argument can turn it into a write. Listing secrets needs admin access, which a workflow's
own `GITHUB_TOKEN` does not have: in CI, use a GitHub App token with the Secrets and Organization secrets read
permissions, passed as `GH_TOKEN`. A repository secret is named `NAME`, an environment secret `env:ENVIRONMENT/NAME`,
and an organization secret is declared as `github: ORG/NAME`.

A location matches a stored secret when its kind is the source kind and its ref is the name, `SCOPE/NAME`, or the
store's full path (`projects/SCOPE/secrets/NAME`, or a vault's secret URL). Names match in any letter case. An expiry the store reports fills in an entry whose `expires` is
`unknown`. A filtered source lists only part of its store, so it never reports a declared secret as `missing`. A
store that cannot be read fails the run, so a check never passes on a partial view. `tally check
--offline` skips the stores; `issues sync` never does, because skipping them would close their issues.

In CI, log in to the store before the tally step, for example with workload identity on GCP:

```yaml
    permissions: { contents: read, issues: write, id-token: write }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      # GitHub's Ubuntu runners ship gcloud, and this step hands it the credentials.
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
          service_account: tally-reader@PROJECT.iam.gserviceaccount.com
      - uses: OWNER/tally@v1
```

## Provider key listings

Some providers list their own keys with expiry, spend limit and last use, through an admin API. These are sources
too, read with an admin token from an environment variable:

```yaml
sources:
  - openrouter: team             # a label for the account, used in locations
  - cloudflare: user             # or a 32-character account id
  - anthropic: org
    filter: wrkspc_01            # optional workspace id
  - openai: org
    filter: proj_abc             # optional project id
    token: OPENAI_READER         # optional; the variable to read instead of the default
```

| Kind | Default token variable | Token to create | Reports |
|---|---|---|---|
| `cloudflare` | `TALLY_CLOUDFLARE_TOKEN_READER` | A custom token with only API Tokens Read (user) or Account API Tokens Read | expiry, last use |
| `openrouter` | `TALLY_OPENROUTER_MANAGEMENT_KEY` | A management key, scoped to one workspace where possible | expiry, spend limit, last use |
| `anthropic` | `TALLY_ANTHROPIC_ADMIN_KEY` | An Admin API key | expiry |
| `openai` | `TALLY_OPENAI_ADMIN_KEY` | An admin key | expiry, last use |

Only Cloudflare offers a token that can read and do nothing else. The others can also create and revoke keys, so give
them the shortest expiry the provider allows, declare each one in `.tally.yaml` so tally warns before it expires, and
keep them out of anything a pull request can run (see below).

The token is read in one place and sent only to that provider's own API host. That code sends GET requests and
nothing else, only to the provider's key or project listing paths, refuses redirects, stops after 20 seconds and
10 MB, and reports a failure by HTTP status alone, never the response. Readers keep the key's name, dates, limit and
last use, and drop everything else the provider returns, including partial key hints. A location for a provider key
is `KIND: LABEL/NAME`, such as `openrouter: team/app`, or `openai: org/PROJECT_ID/NAME`. Provider key names are free
text, so `init` links one onto an entry only when an entry already names it, and never drafts one.

In CI, keep the admin tokens in a GitHub environment that only the default branch can use, so no pull request can
read them, and pass them only to the tally step:

```yaml
    environment: tally
    steps:
      - uses: OWNER/tally@v1
        env:
          TALLY_OPENROUTER_MANAGEMENT_KEY: ${{ secrets.TALLY_OPENROUTER_MANAGEMENT_KEY }}
```

## Commands

```sh
tally init [--owner HANDLE]        # draft or extend .tally.yaml from workflows, env templates and stores
tally                              # browse keys and findings in the terminal
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
`--config PATH` and `--json`. `--offline` skips the secret stores in `check`, `notify`, `init` and `ui`.

`tally` opens a terminal dashboard with the most urgent key first and the selected key's facts and findings below
the list. It uses OpenTUI selection, input and scrolling controls. `tally ui` is an alias. `tab` switches to findings,
`/` filters, `s` changes the sort, `r` reloads and `q` quits. `d` focuses the details for scrolling; `esc` returns to the list. It needs a terminal and does not take `--json`.

## Daily issues

- Each action finding gets one issue, labelled `tally` plus its kind (`tally:expired`, `tally:unregistered`). The id
  is stable, so the same issue is edited as a key moves from "expires in 20 days" to "expired".
- Each issue for an entry is assigned to that entry's `owner` after it is created, unless the owner is an organization.
  When gh rejects the owner, the issue stays unassigned; the failure is reported in the sync output and retried on the
  next run, so a finding never gets two issues.
- Every gap finding shares one digest issue listing the keys with missing expiry, limit, service or assignable owner
  facts.
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
- Reading a new kind of store is one more `Store` in `src/stores.ts`: a scope, and a `list` that turns the vendor
  CLI's listing into names and dates, plus its listing command in `metadataCommands`, the only commands tally runs.
- New checks are `Rule` functions in `src/reconcile.ts`. A rule takes every entry plus the context and returns
  findings. It never writes. The default rules run expiry, limit, the scan checks, staleness and the store
  comparison.
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
