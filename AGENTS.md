# tally

A metadata-only registry of a repository's API keys: one `.tally.yaml` at the root recording owner, location, limit and
expiry for every key. A scheduled job files issues for the keys that are expiring, that no workflow declares, or that
are missing facts. The CLI is the primary surface, and agents are a primary user of it, so JSON output and exit codes
matter as much as the prose.

## Commands

```sh
bun install --frozen-lockfile
bun run gate
bunx biome ci .
bunx tsc --noEmit
bun test
bun scripts/changelog.ts --check
bun src/index.ts --config .tally.yaml validate
```

`bun run gate` runs the rest in one command. Every change that touches behaviour needs a `CHANGELOG.md` entry under
`[Unreleased]`, because the changelog script turns an entry into release notes. CI also runs actionlint, zizmor and
gitleaks over the workflows and the full history.

`assets/logo.svg` is the mark. `python3 scripts/wordmark.py` regenerates the light and dark wordmarks the README shows.

## Layout

- `src/schema.ts`: the entry format, the validator and the credential-shaped text guard
- `src/tallyfile.ts`: load and write `.tally.yaml`, and find it from a directory
- `src/scan.ts`: the secrets a repository's workflows and env templates name, by name only
- `src/stores.ts`: read-only store readers (gcp, aws, azure) and the listing commands, the only ones they may run
- `src/reconcile.ts`: `Rule` functions and the findings they return
- `src/issues.ts`: the desired issues, and the `gh` calls that sync them
- `src/cli.ts`: argument parsing, output, exit codes
- `action.yml`: the composite action a repository calls to run `issues sync`
- `.tally.yaml`: this repository's keys, which are none
- `skills/tally/SKILL.md`: the workflow handed to an agent

## Rules

- tally never reads, stores or sends a secret value. Every field is metadata, and the validator rejects text that
  looks like a credential. Never add a flag, prompt or log line that asks for a value.
- No hard-coded lists of services, groups or location kinds. A new provider, team or secret store is an entry.
- No particular company, product, repository or provider in code or docs. Examples are neutral, such as
  `example-provider` and `owner/name`.
- New checks are `Rule` functions in `src/reconcile.ts`. A rule takes every entry plus the context, returns findings and
  does not write.
- `action` findings exit 3 and get their own issue. `gap` findings share one digest, so a missing fact never looks like
  an expiring key.
- The entry `id` is unique within the file. Issue ids and `rotated` history come from it, so renaming a key renames its
  issue too.
- Commits are signed Conventional Commits.
