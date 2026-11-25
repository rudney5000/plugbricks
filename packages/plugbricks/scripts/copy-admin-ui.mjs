#!/usr/bin/env node
// Runs in prepack: the published package carries the built admin UI under dist/admin/ui, so that
// `plugbricks admin` finds it without the monorepo around it.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(pkg, "..", "admin", "dist");
const to = join(pkg, "dist", "admin", "ui");
if (!existsSync(join(from, "index.html"))) {
  console.error('the admin UI is not built: run "npm run build -w plugbricks-admin" before packing');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied the admin UI to ${to}`);

// The built UI contains the code of React, React Router and what they depend on, which are MIT: their licence
// notices must travel with it. The list is the admin's runtime dependencies, followed through node_modules, plus
// Tailwind, whose output the CSS carries. The file sits next to the UI folder, not in it, so the admin does not serve it.
const adminDir = join(pkg, "..", "admin");
const readPackage = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const folder = join(dir, "node_modules", name);
    if (existsSync(join(folder, "package.json"))) return { folder, json: JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) };
    if (dirname(dir) === dir) throw new Error(`third-party notices: ${name} is not installed (run npm ci)`);
  }
};
const found = new Map();
const visit = (name, from) => {
  if (found.has(name)) return;
  const { folder, json } = readPackage(name, from);
  found.set(name, { folder, json });
  for (const dep of Object.keys(json.dependencies ?? {})) visit(dep, folder);
};
for (const name of [...Object.keys(JSON.parse(readFileSync(join(adminDir, "package.json"), "utf8")).dependencies ?? {}), "tailwindcss"]) {
  visit(name, adminDir);
}
const notices = [...found]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { folder, json }]) => {
    const file = readdirSync(folder).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    if (!file) throw new Error(`third-party notices: ${name} has no licence file`);
    return `${name} ${json.version} (${json.license})\n${"-".repeat(72)}\n${readFileSync(join(folder, file), "utf8").trim()}\n`;
  });
const header = "Third-party code in the admin UI of plugbricks (dist/admin/ui). Each package is under the licence shown below.\n\n";
writeFileSync(join(pkg, "dist", "admin", "THIRD_PARTY_NOTICES.txt"), header + notices.join("\n"));
console.log(`wrote the notices of ${notices.length} third-party packages`);
