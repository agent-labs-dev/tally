# Contributing

Bug reports and pull requests are welcome. [AGENTS.md](AGENTS.md) has the layout and the rules a change must keep.

## Before you start

- **Bugs:** open an issue with the command you ran, the tally version, and the output with any value-like text
  removed. Never paste a secret value, even a revoked one.
- **New checks, stores and larger changes:** open an issue first, so we can agree how the change keeps tally
  metadata-only.
- **Security issues:** report them privately, as [SECURITY.md](SECURITY.md) describes.

## Making a change

```sh
bun install --frozen-lockfile
bun run gate
```

A change needs:

- a passing `bun run gate` (Biome, `tsc`, the tests, the changelog check and `tally validate`)
- a test for each new rule or store, including the case that must report nothing
- a line under Unreleased in `CHANGELOG.md` if a user would notice it
- matching updates to `README.md` and `skills/tally/SKILL.md` if a command, flag or finding changed

Tests never call a real store or provider. Pass a fake runner as `test/stores.test.ts` does, and build any
credential-shaped fixture at runtime so secret scanners stay quiet.

Keep PRs to one idea and use [Conventional Commits](https://www.conventionalcommits.org/) for titles. Commits must be
signed.

## Releasing

A PR sets `version` in `package.json` and moves the Unreleased lines under a new `## [X.Y.Z] - YYYY-MM-DD` heading.
Once it merges, tag the merged commit with `git tag -s vX.Y.Z` and push the tag. The release workflow checks the tag
is signed, is on main and matches `package.json`, and publishes a GitHub release whose notes are that version's
changelog entry.
