# Changelog

What changed in each release, in the terms someone using tally would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version's entry is also its GitHub release notes.

## [Unreleased]

First release.

- **Keys found from the code.** Credential-named variables in tracked env templates count as keys the code reads,
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
