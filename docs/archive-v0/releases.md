> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../superpowers/specs/2026-05-23-lich-v1-design.md` (product spec), `../superpowers/specs/2026-05-23-lich-v1-testing-standards.md` (testing standards), and `../superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md` (current plan). See `./README.md` in this directory for context.

---

# Releases

Lich uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing across the multi-package workspace. Each package in `packages/*` is versioned independently; consumers install the ones they need.

## Quick reference

| Step | Command | What it does |
| ---- | ------- | ------------ |
| 1. Author a changeset | `bun changeset` | Interactively pick which packages changed and the semver bump (patch / minor / major). Writes a markdown file under `.changeset/`. |
| 2. Bump versions | `bun version-packages` | Consumes pending changeset files, bumps `package.json` versions, regenerates each package's `CHANGELOG.md`, and refreshes `bun.lock`. |
| 3. Publish | `bun release` | Runs `changeset publish`, which pushes each package whose local version is ahead of the registry. Requires `NPM_TOKEN` to be exported (or whichever registry token your `.npmrc` expects). |

To preview which packages would actually publish without writing to the registry, run `bun changeset status --verbose` first — it lists every package whose local version is ahead of what's on the registry (changesets itself does not support a `publish --dry-run` flag).

## First publish (0.1.0)

For the **very first** publish, skip steps 1 and 2 and run `bun release` directly. Every `@lich/*` package is already pinned at `0.1.0` in `package.json`, so `changeset publish` will treat that as the version to ship.

Why no changeset for the initial release? Most plugin packages declare `@lich/core` as a `peerDependency`. Changesets' default behavior is that any bump to a package which appears as a peer dep of another package automatically promotes that consumer to a `major` bump (because changing the peer-dep range is breaking for downstream consumers). For our case, that means a single `minor` changeset on `core` cascades every plugin straight to `1.0.0`, overshooting the intended `0.1.0` debut. Authoring the initial release manually sidesteps that. From the second release onwards, the cascade is exactly what you want — patches stay localized, but anything touching `core`'s peer surface correctly fans out as a breaking change for plugin consumers.

Concrete first-publish sequence:

```bash
git checkout master
git pull
bun changeset status --verbose                 # sanity-check what will publish
bun release                                    # publishes every @lich/* at 0.1.0
```

After the initial publish lands and the registry has `0.1.0` recorded for every package, the standard "author changeset → version-packages → release" flow takes over for every subsequent change.

## Day-to-day flow

1. **Open a PR with a changeset.** When you make a user-visible change to any `@lich/*` package, run `bun changeset` before opening the PR. Select the affected packages, pick the bump level, and write a one-line description. The generated markdown lives under `.changeset/` and gets reviewed alongside the code.
   - **Patch** — bug fix, internal refactor, doc-only change.
   - **Minor** — new feature, additive API surface, new plugin.
   - **Major** — breaking API change. Use sparingly pre-1.0; pre-1.0 minors are allowed to be breaking by semver, but we still tag them as `major` if they're disruptive enough that downstream code will need updates.

2. **Merge to master.** The changeset markdown comes along with the code change. No version bump happens at merge time.

3. **Cut a release.** When you're ready to ship a batch of merged PRs:
   ```bash
   git checkout master
   git pull
   bun version-packages          # bumps versions + writes CHANGELOG.md entries + updates bun.lock
   git add -A
   git commit -m "chore: version packages"
   git tag -a vYYYY.MM.DD -m "Release"   # optional umbrella tag
   git push --follow-tags
   bun release                   # publishes to the configured registry
   ```

4. **Done.** Each published package gets its own git tag (`@lich/core@0.2.0`, etc.) automatically by `changeset publish`.

## Authentication and registry

`access` is set to `public` in `.changeset/config.json`, so packages publish to the public npm registry by default. To publish:

- **Public npm** — set `NPM_TOKEN` in your shell (or in CI), and ensure your `~/.npmrc` contains:
  ```
  //registry.npmjs.org/:_authToken=${NPM_TOKEN}
  ```
  The first publish of each `@lich/*` package requires the npm account / org to own the `@lich` scope. If the scope doesn't exist yet, an org admin must create it on npmjs.com first.

- **GitHub Packages** — override the registry in `.npmrc`:
  ```
  @lich:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
  ```
  No changes to `.changeset/config.json` needed; changesets uses whatever registry the package's `publishConfig` (or root `.npmrc`) resolves to.

- **Verdaccio (private mirror)** — point `.npmrc` at the Verdaccio instance:
  ```
  @lich:registry=https://your-verdaccio.example.com
  //your-verdaccio.example.com/:_authToken=${VERDACCIO_TOKEN}
  ```
  You may also want to flip `access` to `restricted` in `.changeset/config.json`.

## CI automation (future)

This repo deliberately does not include a GitHub Action for releases yet — the publish flow is manual until the registry choice is finalized. When you're ready to automate, the official [`changesets/action`](https://github.com/changesets/action) workflow handles the typical pattern: on every push to `master`, it either opens a PR titled "Version Packages" that bundles all pending changesets and runs `version-packages`, or, if such a PR already exists, runs `release` to publish whatever the merged version PR just landed. Drop a workflow file at `.github/workflows/release.yml` using that action's template and add `NPM_TOKEN` to repo secrets when the time comes.

## Notes and gotchas

- **`main` points at raw TypeScript.** Every package currently exports source from `./src/index.ts` rather than a compiled `dist/`. That works inside this bun-only monorepo, but downstream npm consumers who use `tsc`/`node`/`webpack` will need the source compiled to JS for them. If publishing to public npm becomes the primary distribution channel, add a `build` step (e.g. `tsup` or `tsc --outDir dist`) per package and update each `main`/`exports`/`files` accordingly before the first publish.
- **Workspace protocol dependencies.** Packages depend on each other via `workspace:*`. `changeset version` rewrites these to actual semver ranges in the published tarball, so consumers don't see `workspace:*` after install.
- **Private packages.** Anything with `"private": true` in its `package.json` is excluded from `changeset publish`. Today no `@lich/*` package is private; if you add internal-only fixtures or example apps, mark them private and they'll skip publishing automatically.
- **Base branch.** `.changeset/config.json` has `baseBranch: "master"`. Changeset status diffs against this branch to decide which changesets are pending; update it if the main branch is ever renamed.
- **Peer-dep cascade.** If you bump `@lich/core` (or any package that is a `peerDependency` of others), `changeset version` will auto-add `major` bumps for every consumer in the same release. That's correct semver behavior — a changed peer-dep range is breaking for downstream — but means you can't ship a small `core` patch without flushing every plugin too. When that's not what you want, split the work: land internal-only changes that don't touch the published API surface separately, or restructure so the change doesn't sit in a peer-exported file.
