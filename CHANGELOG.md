# Changelog

## [0.5.0](https://github.com/RPate97/lich/compare/v0.4.0...v0.5.0) (2026-06-06)


### Features

* **daemon:** honor LICH_DAEMON_HOST env var for non-loopback bind ([4e218b3](https://github.com/RPate97/lich/commit/4e218b36164c7c0ce7b7c58bf4c0941bdc4898f0))
* docs+skills unification, lich-work-feedback batch, metrics visibility, scrub ([68b5226](https://github.com/RPate97/lich/commit/68b5226a9d804479977c95f8978bc8f0130ff855))
* **env:** env_files in worktrees fall back to the main worktree ([50c15e0](https://github.com/RPate97/lich/commit/50c15e0400613fb8993f2f816bcdfe1d2c57153d))
* **interp:** resolve \${...} in cmd:, lifecycle:, commands.*.cmd: (LEV-514) ([b18e32d](https://github.com/RPate97/lich/commit/b18e32d127c85eb7adc32fee846491695357a77c))
* lich v1 ([a02547d](https://github.com/RPate97/lich/commit/a02547de93332d1bb8b5d5d53e29f2ef20a6a187))
* **logs:** migrate hook storage to logs/&lt;source&gt;.log ([23582b8](https://github.com/RPate97/lich/commit/23582b8dd63c0756f9f2b31ede21e602e1452f5d))
* **logs:** source-based model + cursor pagination + grep + agent-friendly default ([cba7fdd](https://github.com/RPate97/lich/commit/cba7fdd5159fa6e15c276dab3f85692a6c600e71))
* **skill:** add VERSION marker to lich-instrument skill ([ea4e177](https://github.com/RPate97/lich/commit/ea4e177a72a406bf63a7d5a0db897f0fa66d6d27))
* **telemetry:** add opt-out anonymous CLI usage telemetry ([83e5a1b](https://github.com/RPate97/lich/commit/83e5a1b63b2a913adfa3be6d6b9dd75682b7bdc7))
* **up:** don't auto-open the dashboard by default ([7c06048](https://github.com/RPate97/lich/commit/7c060485aad40a59db659e5ab36999f314663086))


### Bug Fixes

* **ci:** build binaries inline in release-please.yml — atomic draft -&gt; publish ([481b80a](https://github.com/RPate97/lich/commit/481b80adcb068afe024ef403a5a97795d067489b))
* **ci:** docs-deploy build step uses working-directory ([4ec74c7](https://github.com/RPate97/lich/commit/4ec74c7ba253914a519da86f3ca250add2eb8c65))
* **ci:** release-please uses PAT so release.yml fires on publish ([9dbf376](https://github.com/RPate97/lich/commit/9dbf3769e056f50f6c312ce933ee45474eb57c86))
* **ci:** repair release.yml YAML structure broken in 32d16ff ([06bb6ea](https://github.com/RPate97/lich/commit/06bb6eae9e2af71d1b5c8abfed33022be6085bcf))
* **dashboard:** per-service log tail so chatty services don't starve quiet ones ([5964821](https://github.com/RPate97/lich/commit/596482104b1f450887661ead84d5121692fb63f8))
* **discover:** expand parent name in profile owned: lists (LEV-520) ([ddda0c7](https://github.com/RPate97/lich/commit/ddda0c7e53c58d29fa6a66769c6db90301aca998))
* **down:** snapshot resolved env/stop_cmd/deps at up time; down reads snapshot (LEV-513) ([51a9ca4](https://github.com/RPate97/lich/commit/51a9ca473aa259de49fd038fc833ccf0fceadec0))
* **fail-when:** skip prior-run log bytes so stale content cannot trip fail_when on second up ([17285f0](https://github.com/RPate97/lich/commit/17285f02ff54a8f8060aaf5da84034b9a12b4e46))
* invoke oneshot stop_cmd on cascade-kill / startup-failure teardown (LEV-511) ([3ec8940](https://github.com/RPate97/lich/commit/3ec894012f49646bc01db10c812a443d49566a1f))
* **lifecycle:** dump full log inline on hook failure, not 3-line stderr tail ([d2d2f8a](https://github.com/RPate97/lich/commit/d2d2f8a6aec7117b165781750787fd82f96737dc))
* **ready:** accept bare port for ready_when.tcp, default host to localhost ([22661ae](https://github.com/RPate97/lich/commit/22661ae84dce528ee2282a2983be80988d48c364))
* **release:** portable sed -i for BSD/GNU (followup LEV-522) ([e04dd5d](https://github.com/RPate97/lich/commit/e04dd5debd70fa191ecaf7ff56577139362d9103))
* **release:** sync version.ts to release tag before build (LEV-522) ([475e41b](https://github.com/RPate97/lich/commit/475e41b93f5fd245440098fbdb01d175ecace393))
* **restart:** per-service restart — lich restart &lt;service&gt; ([014635e](https://github.com/RPate97/lich/commit/014635e786e0331b4ed016f3ae2483260fcab1dc))
* **restart:** preserve active profile across restart (LEV-517) ([891f384](https://github.com/RPate97/lich/commit/891f384a72d65ec254d43c1842e395249e40b99f))
* **telemetry:** close the unit-test leak — bun test ignored vitest.config.ts ([095c5ea](https://github.com/RPate97/lich/commit/095c5eae6bc7ea4663d74d0dcfab1cf9ffeefddb))
* **telemetry:** derive distinct_id from machine identity, not random UUID per LICH_HOME ([947af46](https://github.com/RPate97/lich/commit/947af4642e255df97d92b6a65215a7eacdb72fdf))

## [0.4.0](https://github.com/RPate97/lich/compare/v0.3.1...v0.4.0) (2026-06-06)


### Features

* **up:** don't auto-open the dashboard by default ([7c06048](https://github.com/RPate97/lich/commit/7c060485aad40a59db659e5ab36999f314663086))


### Bug Fixes

* **ci:** build binaries inline in release-please.yml — atomic draft -&gt; publish ([481b80a](https://github.com/RPate97/lich/commit/481b80adcb068afe024ef403a5a97795d067489b))
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
