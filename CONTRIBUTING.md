# Contributing

Contributions are welcome. Keep changes small, focused, and traceable.

## Development workflow

Use the Node.js version in [`.nvmrc`](./.nvmrc). Install dependencies from the root:

```sh
npm install
```

`npm install` also wires the repository git hooks (`core.hooksPath` → `.githooks/`).

To try changes, use the example app in [`example/`](./example). It has its own `package.json` (Electron as a dev dependency) and is not part of the npm package:

```sh
npm install --prefix example
```

### Commands

```sh
npm start        # start the viewer on http://localhost:8094 (project: current folder)
npm run example  # start the viewer with example/ as the project to launch
npm run mcp      # start the MCP server (stdio)
npm run check    # syntax-check the sources
```

## Branching model

Two permanent branches, both protected:

- **`main`** — production. No direct pushes; changes land only through an approved Pull Request.
- **`beta`** — release candidate.

Temporary branches, always created from `beta`, in kebab-case:

- `feat/<name>` · `fix/<name>` · `chore/<name>` → Pull Request **into `beta`**, deleted after merge.
- `hotfix/<name>` is the only exception: created from `main`, PR into `main`, then back-merged into `beta`.

One branch = one focused change.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>)(!): <imperative description>
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`.

[SemVer](https://semver.org/) mapping: `feat` → MINOR, `fix` → PATCH, breaking (`feat!` or `BREAKING CHANGE:`) → MAJOR.

The git hooks in [`.githooks/`](./.githooks) run for every commit:

- `commit-msg` rejects messages that are not Conventional Commits.
- `pre-commit` blocks direct commits on `main` and `beta`.

One-off bypass (not recommended): `git commit --no-verify`.

## Changelog

Any change that affects behavior updates [`CHANGELOG.md`](./CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/)): add the entry under `## [Sin liberar]` in the right category (Añadido · Cambiado · Corregido · Eliminado).

## Pull Requests

When opening a PR:

- Target `beta` (or `main` only for `hotfix`).
- Keep it small and focused on one change.
- Assign at least one reviewer; merge requires their approval.
- Link the related work item for traceability.
- Gates must be green: `npm run check`. CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs it on every PR to `beta` or `main`.
- Include the `CHANGELOG.md` entry.

## Releasing (`beta` → `main`)

1. Confirm gates are green on `beta`.
2. Decide the SemVer bump from the commits since the last tag.
3. Update `version` in `package.json` (`server.json` takes it from there when the MCP Registry workflow runs).
4. Rename the `## [Sin liberar]` section of the changelog to `## [X.Y.Z] - YYYY-MM-DD` and open a fresh empty one.
5. Tag `vX.Y.Z` on `main`.
