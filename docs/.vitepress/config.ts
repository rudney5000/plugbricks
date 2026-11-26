import { posix } from "node:path";
import { defineConfig } from "vitepress";

// The documentation site (D40). Its sources are the Markdown files of docs/, read in place: no page is a copy of another.

const REPOSITORY = "https://github.com/rudney5000/plugbricks";

export default defineConfig({
  title: "plugbricks",
  description: "Assemble a federated GraphQL platform from bricks, and run it on Docker Compose or Kubernetes.",
  lang: "en-US",
  // The address of a project page on GitHub Pages: https://<owner>.github.io/plugbricks/
  base: "/plugbricks/",
  // The owner's own checklist is not for the readers of the site.
  srcExclude: ["pre-publication-checklist.md"],
  markdown: {
    // The documents write <name> and <brick> in plain text: they are words, not HTML.
    html: false,
    config(md) {
      // "{{...}}" in inline code is text too, not a Vue expression.
      const inline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (...args) => inline(...args).replace(/^<code/, "<code v-pre");
      // A ```mermaid block is drawn by the theme (Mermaid.vue).
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, ...rest) =>
        tokens[index].info.trim() === "mermaid"
          ? `<Mermaid code="${encodeURIComponent(tokens[index].content)}" />`
          : fence(tokens, index, ...rest);
      // A link that leaves docs/ (to the code, to CONTRIBUTING.md) goes to the file on GitHub.
      md.core.ruler.push("repository-links", (state) => {
        const page: string = state.env.relativePath ?? "";
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === "link_open" ? token.attrGet("href") : null;
            if (!href || /^([a-z]+:|#|\/)/i.test(href)) continue;
            const target = posix.normalize(posix.join("docs", posix.dirname(page), href));
            if (!target.startsWith("docs/")) token.attrSet("href", `${REPOSITORY}/blob/main/${target}`);
          }
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Decisions", link: "/decisions" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "A project and its bricks", link: "/guide/project" },
          { text: "Writing a service", link: "/guide/services" },
          { text: "Writing a brick", link: "/guide/bricks" },
          { text: "Databases, queues and tokens", link: "/guide/capabilities" },
          { text: "Existing services", link: "/guide/existing-services" },
          { text: "Running a platform", link: "/guide/running" },
          { text: "The admin", link: "/guide/admin" },
          { text: "Known limits", link: "/guide/limits" },
        ],
      },
      {
        text: "How it is built",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Keycloak with the admin", link: "/keycloak" },
          { text: "Decisions", link: "/decisions" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: REPOSITORY }],
    editLink: { pattern: `${REPOSITORY}/edit/main/docs/:path` },
  },
});
