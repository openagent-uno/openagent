import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const org = "https://github.com/openagent-uno";
const productRepo = "https://github.com/openagent-uno/openagent";
const site = "https://openagent.uno/";
const base = "/";

const guideSidebar = [
  {
    text: "Guide",
    items: [
      { text: "Overview", link: "/guide/" },
      { text: "Getting Started", link: "/guide/getting-started" },
      { text: "Invitation System & Networking", link: "/guide/invitation-system" },
      { text: "Models", link: "/guide/models" },
      { text: "MCP Tools", link: "/guide/mcp" },
      { text: "Client Computer Tools", link: "/guide/client-capabilities" },
      { text: "Phone & SMS MCP", link: "/guide/phone-mcp" },
      { text: "Gateway", link: "/guide/gateway" },
      { text: "Channels", link: "/guide/channels" },
      { text: "Memory & Vault", link: "/guide/memory" },
      { text: "Vault Quality System", link: "/guide/vault-quality" },
      { text: "Scheduler & Dream Mode", link: "/guide/scheduler" },
      { text: "Desktop App", link: "/guide/desktop-app" },
      { text: "Architecture", link: "/guide/architecture" },
      { text: "Deployment", link: "/guide/deployment" },
      { text: "Config Reference", link: "/guide/config-reference" },
      { text: "Changelog", link: "/guide/changelog" },
    ],
  },
  {
    text: "Examples",
    items: [
      { text: "Overview", link: "/examples/" },
      { text: "Example Config", link: "/examples/openagent-yaml" },
      { text: "systemd Service", link: "/examples/workspace-mcp-service" },
    ],
  },
];


export default withMermaid(defineConfig({
  title: "OpenAgent",
  description:
    "Persistent AI agent framework with MCP tools, long-term memory, and multi-channel support.",
  lang: "en-US",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}favicon/favicon.ico`, sizes: "any" }],
    ["link", { rel: "icon", href: `${base}favicon/favicon.svg`, type: "image/svg+xml" }],
    ["link", { rel: "apple-touch-icon", href: `${base}favicon/apple-touch-icon.png` }],
    ["link", { rel: "manifest", href: `${base}favicon/site.webmanifest` }],
    ["meta", { name: "theme-color", content: "#050810" }],
    ["meta", { name: "color-scheme", content: "dark" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "OpenAgent" }],
    ["meta", { property: "og:title", content: "OpenAgent" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Persistent AI agent framework with MCP tools, long-term memory, and multi-channel support.",
      },
    ],
    ["meta", { property: "og:url", content: site }],
    ["meta", { property: "og:image", content: `${site}brand/openagent-logo.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "OpenAgent" }],
    [
      "meta",
      {
        name: "twitter:description",
        content:
          "Persistent AI agent framework with MCP tools, long-term memory, and multi-channel support.",
      },
    ],
    ["meta", { name: "twitter:image", content: `${site}brand/openagent-logo.png` }],
  ],
  themeConfig: {
    logo: "/brand/openagent-icon.png",
    siteTitle: "OpenAgent",
    nav: [
      { text: "Home", link: "/" },
      { text: "Download", link: "/downloads" },
      { text: "Docs", link: "/guide/" },
      { text: "Changelog", link: "/guide/changelog" },
    ],
    sidebar: {
      "/guide/": guideSidebar,
      "/examples/": guideSidebar,
    },
    socialLinks: [{ icon: "github", link: org }],
    search: {
      provider: "local",
    },
    editLink: {
      pattern: `${productRepo}/edit/main/docs/site/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "MIT Licensed",
      copyright: "Copyright 2026 OpenAgent",
    },
  },
  mermaid: {
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    fontFamily:
      "'Rajdhani', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    themeVariables: {
      // JARVIS HUD palette — matches docs/.vitepress/theme/custom.css
      background: "#050810",
      primaryColor: "#0A1322",
      primaryTextColor: "#EEF4FB",
      primaryBorderColor: "#3FC8FF",
      secondaryColor: "#0B1426",
      secondaryTextColor: "#EEF4FB",
      secondaryBorderColor: "#3FC8FF",
      tertiaryColor: "#07101e",
      tertiaryTextColor: "#EEF4FB",
      tertiaryBorderColor: "#5FD2FF",
      lineColor: "#3FC8FF",
      textColor: "#EEF4FB",
      mainBkg: "#0A1322",
      nodeBorder: "#3FC8FF",
      clusterBkg: "#07101e",
      clusterBorder: "rgba(63, 200, 255, 0.40)",
      titleColor: "#3FC8FF",
      edgeLabelBackground: "#0A1322",
      // Sequence / state / class / cron accents
      actorBkg: "#0A1322",
      actorBorder: "#3FC8FF",
      actorTextColor: "#EEF4FB",
      actorLineColor: "#5FD2FF",
      signalColor: "#7FE0FF",
      signalTextColor: "#EEF4FB",
      labelBoxBkgColor: "#07101e",
      labelBoxBorderColor: "#3FC8FF",
      labelTextColor: "#EEF4FB",
      loopTextColor: "#EEF4FB",
      noteBkgColor: "rgba(63, 200, 255, 0.12)",
      noteBorderColor: "#3FC8FF",
      noteTextColor: "#EEF4FB",
      activationBkgColor: "#0A1322",
      activationBorderColor: "#5FD2FF",
    },
  },
}));
