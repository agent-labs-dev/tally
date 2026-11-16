# Changelog

What changed in each release, in the terms someone using tally would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version's entry is also its GitHub release notes.

## [Unreleased]

- **The entry field table names `rotated`.** `tally rotated` writes the rotation date there, a key rotated elsewhere can
  record it by hand, `check` does not warn on it, and the key's issue shows it as the last rotation.
- **Keys an organization owns can go to a person.** Set the action's `org-assignee` input, or
  `TALLY_ORG_ASSIGNEE`, to a handle, and their issues are assigned to it with no `org-owner` gap. A repository
  that keeps personal handles out of its tree can pass it from a repository variable.

- **An account name in a note no longer looks like a credential.** The guard now splits text at `@` too, so a
  service account name such as `reader@example-project-123456` passes validation.

- **The tally skill reviews every key.** A new section walks an agent through coverage, missing facts, expiries
  and limits the provider offers, and stale keys, so a clean `check` is not mistaken for an up-to-date registry.

- **Agents can start with bare `tally`.** Outside a terminal it prints schema JSON, including the standard parser's option definitions. Interactive terminals open the dashboard.

- **Run `tally` to open the dashboard.** It opens at once from the tally file and fills in what the secret stores
  report when they answer, so a slow store never holds the screen. Keys nest by group, then service, and every group
  starts folded with a count of what its keys need, so an expiring key shows without opening it. A service with one
  key is that key's row. `enter` or `→` opens a group, `←` folds it or goes to its parent, a filter opens every group,
  and `enter` on a key shows its facts and findings below the list. The dashboard uses one dark palette in every
  terminal, and a reload keeps the selected key. `tally ui` remains an alias.
- **Secret stores are read at once.** `check`, `notify` and the dashboard list every source and look up every owner in
  parallel instead of one after another.
- **CLI options use the standard parser.** Options accept `--name=value`, repeated locations and the `--` separator.

- **A local Unix pass store is a source.** `pass: LABEL` (optionally with a `filter` name prefix) lists the entries under
  `PASSWORD_STORE_DIR` or `~/.password-store` with the modified time of each `.gpg` file, from directory listings only:
  nothing is decrypted or read. Names are case-sensitive, symlinks and a missing store fail the run, and `init` never
  drafts or links a pass entry. The date is when the ciphertext changed, not proof of rotation.
- **Google Cloud annotations carry credential facts.** `tally-owner`, `tally-service`, `tally-expires`,
  `tally-expires-note`, `tally-limit` and `tally-runbook` fill an entry's unknown owner, service, expiry, limit and
  runbook. Values in `.tally.yaml` win, conflicting annotations fail the run, and nothing is written to the file.
- **A Google Cloud secret's `expireTime` is no longer a credential expiry.** It is the date Secret Manager deletes the
  secret, and now raises a `deletion` finding within `warnDays`, whatever the entry's `expires` says.
- **Draft facts are visible.** Keys drafted by `tally init` with `service: unknown` or `owner: unknown` now show
  `unknown-service` and `unknown-owner` gap findings.
- **Help output is predictable.** Commands still print JSON when stdout is not a terminal, while help and version print
  text unless `--json` is given.
- **Text output is aligned.** `check`, `notify` and `list` now show headers with aligned columns, and notifications use
  the same finding table as check output.
- **User fallback errors explain the location.** Outside a repository, a missing user-level tally file now names the
  repository and gives the `tally init` and `tally add` next steps.
- **Organization owners are reported.** Online checks look up owner types and report `org-owner` when a key cannot be
  assigned to an organization, and issue sync stops trying to assign those keys. Lookup failures are ignored, and
  `validate` remains a file-only offline check.
- **Assignment failures are reported and retried.** Issue sync includes assignment failures in its text and JSON output,
  retries them on the next run, and continues with later writes. An edit that only retries the assignment is marked
  `assign only`.

## [0.4.1] - 2026-11-02

- **More env templates.** `env.example` without the leading dot and `NAME.example.env` files are read as env templates
  too.

## [0.4.0] - 2026-11-02

- **GitHub secrets.** `github: OWNER/NAME` reads a repository's Actions and environment secret names and update
  dates, and `github: ORG` an organization's, through `gh`. An Actions secret unchanged for `staleDays` is now
  reported as `stale`, and an organization secret can be declared as `github: ORG/NAME`.
- **Exact GitHub scopes.** A `github` location matches only its own repository, environment or organization, so a
  repository secret no longer stands in for an environment secret of the same name. Environment names may hold
  slashes or other characters GitHub allows.
- **Fewer false workflow secrets.** A job or step named `secrets` (`needs.secrets.result`) is no longer read as a secret.
- **More credential names.** Env templates also count names ending in `PASSPHRASE`, `PAT`, `KEYSTORE` or `HOOK` as
  credentials.

## [0.3.0] - 2026-11-02

- **Provider key listings.** `sources:` reads Anthropic, OpenAI, OpenRouter and Cloudflare key listings through their
  admin APIs, with the token from an environment variable. A provider's expiry and spend limit fill in an unknown one,
  and its last-use date reports a key unused for `idleDays` as `idle`. A provider that says a key never expires or has
  no limit is reported as a `no-expiry` or `no-limit` gap. Requests are GET only, to that provider's own key listing
  paths, with no redirects.

## [0.2.0] - 2026-11-02

- **Terminal view.** `tally ui` lists keys by urgency with the selected key's locations and findings beside it, and a
  second list of every finding. It filters, sorts and reloads in place.
- **`init` extends an existing file.** Running it again adds store copies and new locations to the entry that already
  names that secret, and drafts entries only for secrets nobody declared. A store name that is not credential-shaped is
  never drafted.
- **`ignorePaths`.** Globs for files the workflow and env template scans skip, such as test fixtures.
- **Repeated settings are errors.** A top-level setting written twice in `.tally.yaml` used to let the last one win
  silently; it is now reported by `validate` and every other command.

## [0.1.0] - 2026-11-02

First release.

- **Secret stores.** `sources:` reads names and dates from Google Cloud Secret Manager, AWS Secrets Manager and Azure
  Key Vault through their own CLIs, never values. `check` reports a value unchanged for `staleDays` as `stale`, a
  declared secret the store lacks as `missing`, and a stored secret nobody declared as `unregistered`, and a store's
  expiry fills in an unknown one. `--offline` skips the stores for a quick check.
- **Keys found from the code.** Credential-named variables in tracked env templates, commented out or not, count as keys the code reads,
  next to the secrets workflows reference. `tally init` drafts both, and `check` reports any nobody declared. Only
  names are read, and `credentialNames` adds naming conventions.
- **One file per repository.** Settings and keys live together in `.tally.yaml`: `warnDays`, `issueRepo`,
  `secretPatterns`, `ignore` and `keys`. Discovery is `TALLY_CONFIG`, then the nearest `.tally.yaml` up to the
  repository root, then `~/.config/tally/tally.yaml` for keys that live on one machine. A file can hold many keys, and
  an `id` only has to be unique within it.
- **Metadata, never values.** Every entry records owner, service, optional group, locations, limit and expiry. No
  value is ever read, written or printed, and the validator rejects text that looks like a credential, including
  provider prefixes and long random-looking tokens.
- **Every entry names every copy.** A location is `github:` for this repository, `env:` scoped, or `owner/repo/NAME`
  for another repository, and any other kind is an open slug. A new store needs an entry, not a code change.
- **The workflows are read, never run.** `tally check` compares the secrets `.github/workflows` expressions
  reference against the declared entries. A secret a workflow reads but nobody declared is an `unregistered`
  action finding; a declared Actions secret no workflow reads is an `unused` one. `ignore` lists names that are not
  credentials, and `GITHUB_TOKEN` is always skipped.
- **Start from what exists.** `tally init` writes `.tally.yaml` with a draft entry per referenced secret, so the facts
  to fill in are the ones the repository already depends on.
- **Expiry is checked, missing facts are tracked.** `tally check` exits 3 for expired keys and keys inside the warning
  window. A key with no recorded expiry or limit is a gap, which never blocks a check but is visible in the digest.
- **A daily issue pass.** `tally issues sync` creates one issue per action finding, keeps one digest for gaps, edits
  issues as dates move and closes them when the finding clears. Each entry's issue is assigned to its owner, and stays
  unassigned if gh rejects the owner. With no repository named, gh infers it from the working
  directory.
- **A composite action.** `uses: OWNER/tally@v1` runs `issues sync` with the workflow's own token, so a consuming
  repository adds no tooling and needs only `issues: write`.
- **Desktop notifications.** `tally notify` runs the same check and sends one `notify-send` message per action finding,
  for a timer on a machine that holds keys.
- **Agents first.** `tally check --json` for findings, `tally schema` for the contract, exit codes 0, 1, 2 and 3 that
  name the next step, and machine-readable output when piped.
- **Facts are filled in, never invented.** `expires: unknown` means nobody has looked, `none` needs a written reason,
  and a key can carry the provider's own label plus its redacted fingerprint, at most 6 characters, so two keys with
  the same name can be told apart.
- **Runbooks belong to the user.** `runbook` points at a path or URL in the repository that declares the key. The tool
  ships no provider-specific steps.
