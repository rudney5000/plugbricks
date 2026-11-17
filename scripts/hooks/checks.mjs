// The rules of the git hooks, as pure functions so that they can be tested (test/hooks.test.ts).
// scripts/hooks/pre-commit.mjs applies them to the staged files.

/** Path segments that must never be committed: runtime secrets, generated files, test work folders. */
const FORBIDDEN_DIRECTORIES = [".secrets", ".generated", ".test-work", ".kube"];

/** Golden files of the CLI scenarios are generated output kept on purpose (see .gitignore). */
const ALLOWED_GENERATED = /(^|\/)test\/fixtures\/[^/]+\/[^/]+\/expected\/\.generated\//;

const PRIVATE_KEY_NAMES = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/;
const PRIVATE_KEY_EXTENSIONS = /\.(pem|key|p12|pfx|ppk|jks|keystore)$/i;
const ENV_EXAMPLES = /^\.env\.(example|sample|template)$/;

/**
 * Why a file must not be committed, or undefined when it may be. `path` uses "/" (git's own
 * spelling, on every OS).
 */
export function forbiddenFileReason(path) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (ALLOWED_GENERATED.test(path)) return undefined;

  for (const directory of FORBIDDEN_DIRECTORIES) {
    if (parts.slice(0, -1).includes(directory))
      return `${directory}/ holds secrets, generated files or test work folders and is never committed`;
  }
  if (!ENV_EXAMPLES.test(name) && (name === ".env" || name.startsWith(".env.") || name.endsWith(".env"))) {
    return "an environment file usually holds secrets (only .env.example, .env.sample and .env.template may be committed)";
  }
  if (PRIVATE_KEY_NAMES.test(name) || PRIVATE_KEY_EXTENSIONS.test(name)) return "looks like a private key or a certificate bundle";
  if (name === "kubeconfig" || name.startsWith("kubeconfig.") || name.endsWith(".kubeconfig"))
    return "a kubeconfig file holds cluster credentials";
  return undefined;
}

/** Patterns of well-known secrets. Each one is specific enough to be rare in ordinary text. */
export const SECRET_PATTERNS = [
  { name: "private key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/ },
  { name: "AWS secret access key", pattern: /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: "GitLab token", pattern: /\b(?:glpat|gldt|glptt|glrt|glft|glimt|glagent)-[A-Za-z0-9_-]{20,}/ },
];

/** The secrets found in a text: [{ name, line }] with 1-based line numbers. The secret itself is never returned. */
export function secretFindings(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { name, pattern } of SECRET_PATTERNS) if (pattern.test(line)) found.push({ name, line: index + 1 });
  });
  return found;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/;

/**
 * A source file must start with plain ASCII: a stray character before the first token (a pasted
 * letter, a byte order mark) breaks the file in ways that are hard to see. Returns a reason, or
 * undefined. A "#!" line is fine, it is ASCII too.
 */
export function leadingCharacterProblem(path, content) {
  if (!SOURCE_FILE.test(path) || content.length === 0) return undefined;
  const first = content.codePointAt(0);
  if (first === 0xfeff) return "starts with a byte order mark (U+FEFF)";
  if (first > 0x7f) {
    const code = first.toString(16).toUpperCase().padStart(4, "0");
    return `starts with the non-ASCII character "${String.fromCodePoint(first)}" (U+${code}); a stray character before the first token`;
  }
  return undefined;
}

/** Files Prettier and ESLint are asked about when staged. */
export const LINTABLE = /\.(?:[cm]?[jt]s)$/;
export const FORMATTABLE = /\.(?:[cm]?[jt]s|json|ya?ml)$/;

/** Binary content is not scanned: a NUL byte in the first 8 kB. */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}
