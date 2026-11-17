import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The rules of the git hooks (scripts/hooks/checks.mjs). The fake secrets below are assembled from
// pieces at run time so that this file never contains a string the hook itself would refuse.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const checks = await import(pathToFileURL(join(root, "scripts/hooks/checks.mjs")).href);
const { forbiddenFileReason, secretFindings, leadingCharacterProblem, looksBinary } = checks;

const fake = (...pieces: string[]) => pieces.join("");

describe("forbiddenFileReason", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "config/.env",
    "secrets.env",
    ".secrets/secrets.env",
    "app/.secrets/k8s-secret.yaml",
    ".generated/compose/compose.yaml",
    "demo/.generated/k8s/resources.yaml",
    ".test-work/cli/up/platform.json",
    "packages/plugbricks/.test-work/e2e/x",
    "id_rsa",
    "home/.ssh/id_ed25519",
    "certs/server.pem",
    "certs/tls.key",
    "store.p12",
    "kubeconfig",
    "kubeconfig.yaml",
    "ci/k3d.kubeconfig",
    ".kube/config",
  ])("refuses %s", (path) => {
    expect(forbiddenFileReason(path), path).toMatch(/\S/);
  });

  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    ".gitignore",
    "README.md",
    "packages/plugbricks/src/secrets.ts",
    "packages/plugbricks/test/fixtures/cli/k8s-kubeconfig/scenario.json",
    "packages/plugbricks/test/fixtures/cli/generate-k8s/expected/.generated/k8s/namespace.yaml",
    "docs/environment.md",
    "src/keyboard.ts",
  ])("allows %s", (path) => {
    expect(forbiddenFileReason(path), path).toBeUndefined();
  });

  it("allows golden files under test/fixtures/*/*/expected/.generated/ only", () => {
    expect(forbiddenFileReason("packages/plugbricks/test/fixtures/cli/x/expected/.generated/a.yaml")).toBeUndefined();
    expect(forbiddenFileReason("packages/plugbricks/test/fixtures/cli/x/.generated/a.yaml")).toMatch(/\S/);
    expect(forbiddenFileReason("examples/expected/.generated/a.yaml")).toMatch(/\S/);
  });
});

describe("secretFindings", () => {
  const cases: [string, string][] = [
    ["private key block", fake("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
    ["private key block", fake("-----BEGIN ", "PRIVATE KEY", "-----")],
    ["private key block", fake("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----")],
    ["private key block", fake("-----BEGIN PGP ", "PRIVATE KEY BLOCK", "-----")],
    ["AWS access key id", fake("AK", "IA", "IOSFODNN7EXAMPLE")],
    ["AWS access key id", `key = "${fake("AS", "IA", "ABCDEFGHIJKLMNOP")}"`],
    ["AWS secret access key", fake("aws_secret_", "access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")],
    ["GitHub token", fake("gh", "p_", "a".repeat(36))],
    ["GitHub token", `token: ${fake("gh", "o_", "B1".repeat(20))}`],
    ["GitHub token", fake("github_", "pat_", "11ABCDEFG0abcdefghijkl_", "mnopqrstuvwxyz")],
    ["GitLab token", fake("gl", "pat-", "abcdefghij0123456789")],
    ["GitLab token", `GITLAB_TOKEN=${fake("gl", "ptt-", "abcdefghij0123456789xyz")}`],
  ];

  it.each(cases)("finds a %s", (name, line) => {
    const found = secretFindings(`first line\n${line}\nlast line`);
    expect(found).toEqual([{ name, line: 2 }]);
  });

  it("reports every finding with its line, never the secret", () => {
    const text = [fake("AK", "IA", "IOSFODNN7EXAMPLE"), "fine", fake("gh", "s_", "z".repeat(40))].join("\r\n");
    const found = secretFindings(text);
    expect(found).toEqual([
      { name: "AWS access key id", line: 1 },
      { name: "GitHub token", line: 3 },
    ]);
    expect(JSON.stringify(found)).not.toContain("IOSFODNN");
  });

  it.each([
    "const token = process.env.GITHUB_TOKEN;",
    "BEGIN PRIVATE KEY is mentioned in prose without the dashes",
    "AKIA is a prefix, but too short: AKIA123",
    "ghp_tooshort",
    "glpat-short",
    "sha256: 06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0",
    "PB_POSTGRES__SUPERUSER_PASSWORD=ejzwJQd8IbWRmeTB",
    "aws_secret_access_key is read from the environment",
  ])("does not flag %j", (line) => {
    expect(secretFindings(line)).toEqual([]);
  });
});

describe("leadingCharacterProblem", () => {
  it("fails on a stray Cyrillic letter at the start of a TypeScript file (the bug that cost us a day)", () => {
    const problem = leadingCharacterProblem(
      "packages/plugbricks/test/helpers/pack.ts",
      'лimport { execFileSync } from "node:child_process";\n',
    );
    expect(problem).toContain("non-ASCII");
    expect(problem).toContain("U+043B");
  });

  it("fails on a byte order mark", () => {
    expect(leadingCharacterProblem("src/a.ts", "﻿export const a = 1;\n")).toContain("byte order mark");
  });

  it.each(["a.ts", "b.mts", "c.js", "d.mjs", "e.json", "f.yml"])("checks %s", (path) => {
    expect(leadingCharacterProblem(path, "é")).toMatch(/non-ASCII/);
  });

  it("accepts ASCII starts, a shebang, an empty file, and non-ASCII later in the file", () => {
    expect(leadingCharacterProblem("a.ts", 'import x from "y";\n')).toBeUndefined();
    expect(leadingCharacterProblem("a.mjs", "#!/usr/bin/env node\n")).toBeUndefined();
    expect(leadingCharacterProblem("a.ts", "")).toBeUndefined();
    expect(leadingCharacterProblem("a.ts", '// héllo, мир\nexport const ok = "✓";\n')).toBeUndefined();
  });

  it("leaves other kinds of file alone (Markdown may start with anything)", () => {
    expect(leadingCharacterProblem("README.md", "é")).toBeUndefined();
    expect(leadingCharacterProblem("notes.txt", "л")).toBeUndefined();
  });
});

describe("looksBinary", () => {
  it("detects a NUL byte in the first 8 kB only", () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text\n"))).toBe(false);
    expect(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))).toBe(false);
  });
});
