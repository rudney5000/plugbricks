// The guide of the documentation site (docs/guide/, D40) held to the code, so that it cannot go stale with a green build:
// the commands of "Getting started" run in order against a real project (Docker faked), its queries are checked against
// the composed schema, every manifest the guide shows is validated, and every command and option it names exists.
// What this does not do: build an image or start a container (e2e-compose does, for what the guide's commands run).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, parse, validate } from "graphql";
import { main as plugbricks, validateManifest } from "plugbricks";
import { describe, expect, it } from "vitest";
import { create } from "../lib/create.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const guide = join(repo, "docs/guide");
const work = fileURLToPath(new URL("../.test-work/docs", import.meta.url));
const read = (file) => readFileSync(join(guide, file), "utf8").replaceAll("\r\n", "\n");
const pages = readdirSync(guide).filter((f) => f.endsWith(".md"));

/** The fenced blocks of a page, in order. */
const blocks = (file) => [...read(file).matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1], code: m[2] }));

/** The commands of a shell block: one per line, without comments. */
const commands = (code) =>
  code
    .split("\n")
    .map((l) => l.replace(/\s+#\s.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#"));

/** A Docker that does nothing and answers what plugbricks reads of it. */
const exec = (cmd, args) => {
  const line = [cmd, ...args].join(" ");
  const stdout = line.startsWith("docker ps ")
    ? "abc123\n"
    : line.startsWith("docker version")
      ? "29.8.0 linux\n"
      : line.startsWith("docker compose version")
        ? "5.8.0\n"
        : "";
  return { status: 0, stdout, stderr: "" };
};

function cli(args, cwd) {
  const out = [];
  const err = [];
  const code = plugbricks(args, {
    cwd,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    runtime: { exec, attach: () => 0 },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("Getting started", () => {
  it("runs as it is written: every command succeeds, every query is answered by the composed schema", () => {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    let cwd = work;
    let printed = "";
    let queries = 0;
    const ran = [];
    for (const block of blocks("getting-started.md")) {
      if (block.lang === "graphql") {
        // The page says to add it at the end of the API's schema.
        const schema = join(cwd, "bricks/inventory-api/schema.graphql");
        writeFileSync(schema, `${readFileSync(schema, "utf8")}\n${block.code}`);
        continue;
      }
      if (block.lang === "ts") {
        // The page says on which line to put it: the template must still have that line.
        expect(readFileSync(join(cwd, "services/inventory-api/src/main.ts"), "utf8")).toContain("inventoryItems: () => items,");
        expect(read("getting-started.md")).toContain("after `inventoryItems: () => items,`");
        continue;
      }
      expect(block.lang, "a block the test does not know how to check").toBe("bash");
      for (const line of commands(block.code)) {
        ran.push(line);
        const words = line.split(/\s+/);
        if (line.startsWith("npm create plugbricks@next ")) {
          cwd = work;
          const args = words.slice(3).filter((w) => w !== "--");
          const out = [];
          expect(create(args, { cwd, stdout: (l) => out.push(l), stderr: (l) => out.push(l) }), out.join("\n")).toBe(0);
        } else if (words[0] === "cd") {
          cwd = join(cwd, words[1]);
          expect(existsSync(join(cwd, "platform.json")), line).toBe(true);
        } else if (line === "npm install") {
          // Installs the published command; the test runs the one of this repository.
        } else if (line.startsWith("npx plugbricks ")) {
          const r = cli(words.slice(2), cwd);
          // doctor looks at the real ports of this machine: it may report one as busy, which is not the guide's fault.
          expect(words[2] === "doctor" ? [0, 1] : [0], `${line}\n${r.out}\n${r.err}`).toContain(r.code);
          printed += `${r.out}\n`;
        } else if (line.startsWith("docker build ")) {
          expect(printed, "the build command is the one create printed").toContain(line);
        } else if (line.startsWith("curl ")) {
          const body = /-d '([^']+)'/.exec(line);
          expect(line, "the router's address").toContain("http://127.0.0.1:4000/graphql");
          const config = JSON.parse(readFileSync(join(cwd, ".generated/compose/router-config.json"), "utf8"));
          const errors = validate(buildSchema(config.engineConfig.graphqlSchema), parse(JSON.parse(body[1]).query));
          expect(
            errors.map((e) => e.message),
            line,
          ).toEqual([]);
          queries++;
        } else {
          expect.fail(`a command the test does not check: ${line}`);
        }
      }
    }
    expect(queries).toBe(3);
    expect(ran).toContain("npx plugbricks dev inventory-api --no-follow");
  });
});

describe("the guide", () => {
  const help = (() => {
    const out = [];
    plugbricks(["--help"], { cwd: work, stdout: (l) => out.push(l), stderr: () => {} });
    return out.join("\n");
  })();

  it.each(pages)("%s names only commands and options that exist", (page) => {
    for (const block of blocks(page).filter((b) => b.lang === "bash")) {
      for (const line of commands(block.code).filter((l) => l.startsWith("npx plugbricks "))) {
        // What follows "--" belongs to another program (exec).
        const own = line.split(" -- ")[0].split(/\s+/);
        expect(help, line).toMatch(new RegExp(`^  ${own[2]}[ <\\[]`, "m"));
        for (const option of own.filter((w) => w.startsWith("--"))) expect(help, `${line}: ${option}`).toContain(option);
      }
    }
  });

  /** The manifest the "Writing a brick" page shows in full; its fragments are checked inside it. */
  const example = () => JSON.parse(blocks("bricks.md").find((b) => b.lang === "json").code);

  it("shows only valid manifests", () => {
    let checked = 0;
    for (const page of pages) {
      for (const block of blocks(page).filter((b) => b.lang === "json")) {
        const value = JSON.parse(block.code);
        // Other JSON (a report) is not a manifest.
        if (!value.name || !value.services) continue;
        const r = validateManifest(value);
        expect(r.ok ? [] : r.issues, `${page}: ${value.name}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("shows only fragments that are valid inside a manifest", () => {
    let checked = 0;
    for (const page of pages) {
      for (const block of blocks(page).filter((b) => b.lang === "jsonc")) {
        const fragment = JSON.parse(`{${block.code}}`);
        const base = example();
        const manifest = { ...base, ...fragment };
        // Roles need an identity provider to be asked for (D22).
        if (fragment.authorization) manifest.requires = { ...base.requires, oidc: { optional: true } };
        // A provider's page shows the provider alone: its service is the one the fragment names.
        if (fragment.provides) {
          manifest.services = [...base.services, { name: "db", image: "postgres:16.4-alpine", port: 5432 }];
          delete manifest.requires;
        }
        const r = validateManifest(manifest);
        expect(r.ok ? [] : r.issues, `${page}: ${Object.keys(fragment).join(", ")}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("describes every field of the manifest", () => {
    const schema = JSON.parse(readFileSync(join(repo, "packages/plugbricks/schemas/plugin-manifest.schema.json"), "utf8"));
    for (const field of Object.keys(schema.properties)) expect(read("bricks.md"), field).toContain(`\`${field}\``);
  });

  it("names every variable the provider bricks give their consumers", () => {
    const examples = join(repo, "packages/plugbricks/examples");
    const given = readdirSync(examples).flatMap((brick) => {
      const m = JSON.parse(readFileSync(join(examples, brick, "plugin.json"), "utf8"));
      return Object.values(m.provides ?? {}).flatMap((p) => Object.keys(p.inject));
    });
    expect(given).toContain("DATABASE_URL");
    for (const variable of given) expect(read("capabilities.md"), variable).toContain(`\`${variable}\``);
  });
});
