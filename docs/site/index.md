---
layout: home

hero:
  name: Lich
  text: One YAML. N worktrees. N dev stacks.
  tagline: Run your dev stack with per-worktree isolation — no port juggling, no compose project collisions, no manual env wrangling.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started/
    - theme: alt
      text: Why lich
      link: /getting-started/why-lich
    - theme: alt
      text: GitHub
      link: https://github.com/RPate97/lich

features:
  - title: For evaluators
    details: "Read [Why lich](/getting-started/why-lich) to understand the problem lich solves, who it's for, and how it compares to docker compose / Tilt / shell scripts."
    link: /getting-started/why-lich
  - title: For new users
    details: "Read [Get started](/getting-started/) to install lich, write your first `lich.yaml`, and bring the stack up."
    link: /getting-started/
  - title: For existing users
    details: "Reference: [lich.yaml](/reference/lich-yaml-spec), [CLI commands](/reference/cli), [Recipes](/recipes/), [Troubleshooting](/troubleshooting)."
    link: /reference/lich-yaml-spec
  - title: For agents
    details: "Two skills: `lich-instrument` (write a lich.yaml from scratch) and `lich` (operate a running stack). Install via `npx skills add`."
    link: /getting-started/instrument
---
