import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// ESLint 9 flat config. Style is Prettier's job (eslint-config-prettier switches off every rule that
// would fight it); ESLint looks for bugs only.
export default tseslint.config(
  {
    // Not linted: test inputs and golden files, bricks shipped as examples, the project template
    // (all copied or hashed as they are), and anything generated. Same list as .prettierignore.
    ignores: [
      "**/test/fixtures/**",
      "packages/plugbricks/examples/**",
      "packages/create-plugbricks/template/**",
      "packages/create-plugbricks/bricks/**",
      "packages/plugbricks/templates/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/.test-work/**",
      "**/coverage/**",
      "docs/.vitepress/cache/**",
      ".generated/**",
      ".secrets/**",
      ".platform/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: {
      // A leading underscore marks a parameter that is required by a signature but not used.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
);
