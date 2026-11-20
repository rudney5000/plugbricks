#!/usr/bin/env node
// Runs in prepack: the published package carries the built admin UI under dist/admin/ui, so that
// `plugbricks admin` finds it without the monorepo around it.
import { cpSync, existsSync, rmSync } from "node:fs";
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
