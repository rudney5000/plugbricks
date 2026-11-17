#!/usr/bin/env node
// Pre-commit: fast checks on what is staged. Called by .githooks/pre-commit.
// 1. whitespace errors   2. forbidden files   3. secrets   4. a stray first character
// 5. ESLint and Prettier on the staged content of code files.
// Exit 1 lists every problem found, not only the first.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FORMATTABLE, forbiddenFileReason, LINTABLE, leadingCharacterProblem, looksBinary, secretFindings } from "./checks.mjs";

const git = (args, options = {}) =>
  spawnSync("git", args, { encoding: options.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
const root = git(["rev-parse", "--show-toplevel"]).stdout.trim();
const problems = [];
const problem = (message) => problems.push(message);

// Staged files: added, copied, modified, renamed (not deleted). -z keeps odd names intact.
const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).stdout.split("\0").filter(Boolean);
if (staged.length === 0) process.exit(0);

// 1. Whitespace: trailing spaces, mixed indentation, conflict markers (git's own check).
const whitespace = git(["diff", "--cached", "--check"]);
if (whitespace.status !== 0) problem(`whitespace errors in the staged changes:\n${whitespace.stdout.trimEnd()}`);

const contents = new Map();
for (const path of staged) {
  // 2. Forbidden files.
  const reason = forbiddenFileReason(path);
  if (reason) problem(`${path}: not allowed in a commit: ${reason}`);

  // 3 and 4 read the staged content (what will be committed), not the working tree.
  const blob = git(["show", `:${path}`], { binary: true });
  if (blob.status !== 0 || looksBinary(blob.stdout)) continue;
  const text = blob.stdout.toString("utf8");
  contents.set(path, text);
  for (const { name, line } of secretFindings(text))
    problem(`${path}:${line}: looks like a secret (${name}); remove it, and revoke it if it was ever real`);
  const first = leadingCharacterProblem(path, text);
  if (first) problem(`${path}: ${first}`);
}

// 5. ESLint and Prettier, on the staged content. Files outside their scope (test fixtures, the
// template, generated files) are skipped by their own ignore lists.
const local = (name) => join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
function tool(name, args, input) {
  // .cmd launchers need a shell on Windows; arguments here are fixed flags and a path under the repository.
  return spawnSync(local(name), args, { cwd: root, encoding: "utf8", input, shell: process.platform === "win32" });
}
if (existsSync(local("eslint")) && existsSync(local("prettier"))) {
  for (const path of staged.filter((p) => FORMATTABLE.test(p) && contents.has(p))) {
    const text = contents.get(path);
    {
      const formatted = tool("prettier", ["--stdin-filepath", path], text);
      if (formatted.status === 0 && formatted.stdout !== text && formatted.stdout !== "")
        problem(`${path}: not formatted; run "npx prettier --write ${path}"`);
      if (formatted.status !== 0 && !/ignored/i.test(formatted.stderr)) problem(`${path}: Prettier failed:\n${formatted.stderr.trim()}`);
    }
    if (LINTABLE.test(path)) {
      const linted = tool("eslint", ["--stdin", "--stdin-filename", path, "--no-warn-ignored"], text);
      if (linted.status !== 0) problem(`${path}: ESLint:\n${(linted.stdout || linted.stderr).trim()}`);
    }
  }
} else {
  console.warn("pre-commit: eslint or prettier is not installed (run npm ci); skipped their checks");
}

if (problems.length > 0) {
  console.error(`\npre-commit: ${problems.length} problem(s), nothing was committed:\n`);
  for (const message of problems) console.error(` - ${message}`);
  console.error("\nFix them and commit again. In an emergency only: git commit --no-verify (CI runs the same checks).");
  process.exit(1);
}
