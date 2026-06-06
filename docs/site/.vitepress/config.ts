import { defineConfig } from "vitepress";

// VitePress config for the lich docs site.
//
// Generated reference pages are synced from docs/content/ by
// packages/lich/scripts/sync-content.ts. Edit the canonical sources under
// docs/content/, not the generated mirrors.
export default defineConfig({
  title: "Lich",
  description:
    "Worktree-scoped dev stack orchestrator. Run as many dev stacks as you have worktrees.",
  lang: "en-US",
  // Deployed at https://lich.sh (apex custom domain), so base is "/".
  // Override via LICH_DOCS_BASE for preview deploys at a different prefix
  // (e.g. LICH_DOCS_BASE=/lich/ to preview at rpate97.github.io/lich/).
  base: process.env.LICH_DOCS_BASE ?? "/",
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
    // PostHog: anonymous docs analytics (page views + nav). Respects DNT.
    // Disable by setting localStorage.lich_telemetry_disabled = "1" in devtools.
    [
      "script",
      {},
      `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
if (typeof window !== 'undefined' && localStorage.getItem('lich_telemetry_disabled') !== '1') {
  window.posthog.init('phc_sGvHNd7WNParEj4yL2unUFvUhuWSzvQneQgqR6K9P8Pe', { api_host: 'https://us.i.posthog.com', person_profiles: 'identified_only', respect_dnt: true });
}`,
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Get started", link: "/" },
      { text: "Reference", link: "/reference/lich-yaml-spec" },
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
          { text: "Install + first stack", link: "/" },
          { text: "Why lich", link: "/getting-started/why-lich" },
          {
            text: "Instrument with an agent",
            link: "/getting-started/instrument",
          },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "lich.yaml", link: "/reference/lich-yaml-spec" },
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
        items: [
          { text: "All recipes", link: "/recipes/" },
          { text: "External CLI services", link: "/recipes/external-cli-services" },
          { text: "Monorepo task runners", link: "/recipes/monorepo-task-runners" },
          { text: "Install caching", link: "/recipes/install-caching" },
          { text: "Test key overrides", link: "/recipes/test-key-overrides" },
          { text: "Worker pools", link: "/recipes/worker-pools" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Dashboard", link: "/dashboard" },
          {
            text: "Troubleshooting",
            link: "/troubleshooting",
          },
          { text: "Telemetry", link: "/telemetry" },
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
