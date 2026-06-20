# Changelog

## [0.5.0](https://github.com/RPate97/lich/compare/v0.4.0...v0.5.0) (2026-06-20)


### Features

* **deps:** add pure runGraph scheduler for dependency-graph startup ([11311a6](https://github.com/RPate97/lich/commit/11311a67c3ae973dfb99d60b91d549f984d23fb4))
* **up:** schedule services by dependency graph instead of topological waves ([10f11af](https://github.com/RPate97/lich/commit/10f11af92672306080abc751760b9303a886a64f))
* **up:** schedule services by dependency graph, not topological waves ([dad570e](https://github.com/RPate97/lich/commit/dad570ef0c61f72e5f885cdf62f5b70461f7b82a))


### Bug Fixes

* **telemetry:** hand posthog-node the shutdown timeout instead of racing it ([9161a2c](https://github.com/RPate97/lich/commit/9161a2cc9a33acc5141903ce3ea99cc7fd328286))


### Performance Improvements

* **env:** resolve top-level/profile env_from once per up, not per service ([103573f](https://github.com/RPate97/lich/commit/103573f81fefb1557224a89e253e9a9679c8eb7b))
* **env:** resolve top-level/profile env_from once per up/nuke, not per service ([b4a8468](https://github.com/RPate97/lich/commit/b4a846812e22ca706af33899b96f398bf6acee8a))
* **env:** reuse shared env base across owned stop_cmds in nuke ([a845cc0](https://github.com/RPate97/lich/commit/a845cc09afacde20932494ef1f0c5fc30ca39bb4))

## [0.4.0](https://github.com/RPate97/lich/compare/v0.3.1...v0.4.0) (2026-06-06)


### Features

* **up:** don't auto-open the dashboard by default ([7c06048](https://github.com/RPate97/lich/commit/7c060485aad40a59db659e5ab36999f314663086))


### Bug Fixes

* **telemetry:** close the unit-test leak — bun test ignored vitest.config.ts ([095c5ea](https://github.com/RPate97/lich/commit/095c5eae6bc7ea4663d74d0dcfab1cf9ffeefddb))
* **telemetry:** derive distinct_id from machine identity, not random UUID per LICH_HOME ([947af46](https://github.com/RPate97/lich/commit/947af4642e255df97d92b6a65215a7eacdb72fdf))

## [0.3.1](https://github.com/RPate97/lich/compare/v0.3.0...v0.3.1) (2026-06-06)


### Bug Fixes

* **ci:** repair release.yml YAML structure broken in 32d16ff ([06bb6ea](https://github.com/RPate97/lich/commit/06bb6eae9e2af71d1b5c8abfed33022be6085bcf))

## [0.3.0](https://github.com/RPate97/lich/compare/v0.2.2...v0.3.0) (2026-06-06)


### Features

* **telemetry:** add opt-out anonymous CLI usage telemetry ([83e5a1b](https://github.com/RPate97/lich/commit/83e5a1b63b2a913adfa3be6d6b9dd75682b7bdc7))

## [0.2.2](https://github.com/RPate97/lich/compare/v0.2.1...v0.2.2) (2026-06-05)


### Bug Fixes

* **ci:** release-please uses PAT so release.yml fires on publish ([9dbf376](https://github.com/RPate97/lich/commit/9dbf3769e056f50f6c312ce933ee45474eb57c86))

## [0.2.1](https://github.com/RPate97/lich/compare/v0.2.0...v0.2.1) (2026-06-05)


### Bug Fixes

* **ci:** docs-deploy build step uses working-directory ([4ec74c7](https://github.com/RPate97/lich/commit/4ec74c7ba253914a519da86f3ca250add2eb8c65))

## [0.2.0](https://github.com/RPate97/lich/compare/v0.1.0...v0.2.0) (2026-06-05)


### Features

* **daemon:** honor LICH_DAEMON_HOST env var for non-loopback bind ([4e218b3](https://github.com/RPate97/lich/commit/4e218b36164c7c0ce7b7c58bf4c0941bdc4898f0))
* **env:** env_files in worktrees fall back to the main worktree ([50c15e0](https://github.com/RPate97/lich/commit/50c15e0400613fb8993f2f816bcdfe1d2c57153d))

## [0.1.0](https://github.com/RPate97/lich/compare/v0.0.1...v0.1.0) (2026-05-31)


### Features

* docs+skills unification, lich-work-feedback batch, metrics visibility, scrub ([68b5226](https://github.com/RPate97/lich/commit/68b5226a9d804479977c95f8978bc8f0130ff855))
