import { defineConfig } from "vitepress";

// VitePress config for the lich docs site.
//
// Generated reference pages (reference/lich-yaml.md, recipes/index.md)
// are synced from skills/lich-instrument/references/ by
// scripts/sync-skill-content.mjs at build time. Edit the skill references,
// not the generated files.
export default defineConfig({
  title: "Lich",
  description:
    "Worktree-scoped dev stack orchestrator. Run as many dev stacks as you have worktrees.",
  lang: "en-US",
  cleanUrls: true,
  // The generated reference pages live next to manually-authored content.
  // Don't fail the build if a relative link points at a section that
  // hasn't been written yet — we'll tighten this once V0 stabilizes.
  ignoreDeadLinks: true,
  lastUpdated: true,

  head: [
    [
      "meta",
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0",
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Get started", link: "/getting-started/" },
      { text: "Reference", link: "/reference/lich-yaml" },
      { text: "Concepts", link: "/concepts/worktrees-isolation" },
      { text: "Recipes", link: "/recipes/" },
      { text: "Dashboard", link: "/dashboard" },
      {
        text: "GitHub",
        link: "https://github.com/RPate97/lich",
      },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Install + first stack", link: "/getting-started/" },
          {
            text: "Instrument with an agent",
            link: "/getting-started/instrument",
          },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "lich.yaml", link: "/reference/lich-yaml" },
          { text: "Interpolation", link: "/reference/interpolation" },
          { text: "CLI commands", link: "/reference/cli" },
        ],
      },
      {
        text: "Concepts",
        items: [
          {
            text: "Worktree isolation",
            link: "/concepts/worktrees-isolation",
          },
          { text: "Profiles", link: "/concepts/profiles" },
          { text: "env_groups", link: "/concepts/env-groups" },
          {
            text: "Lifecycle hooks",
            link: "/concepts/lifecycle-hooks",
          },
          {
            text: "Daemon + proxy",
            link: "/concepts/daemon-proxy",
          },
          {
            text: "Oneshot services",
            link: "/concepts/oneshot-services",
          },
        ],
      },
      {
        text: "Recipes",
        items: [{ text: "All recipes", link: "/recipes/" }],
      },
      {
        text: "Operations",
        items: [
          { text: "Dashboard", link: "/dashboard" },
          { text: "Feedback", link: "/feedback" },
          {
            text: "Troubleshooting",
            link: "/troubleshooting",
          },
        ],
      },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/RPate97/lich",
      },
    ],

    editLink: {
      pattern:
        "https://github.com/RPate97/lich/edit/main/docs/site/:path",
      text: "Edit this page on GitHub",
    },

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright (c) Ryan Pate",
    },
  },
});
