import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// graphql 16 ships both index.js (CommonJS) and index.mjs. Node loads index.js for everyone, but
// Vite would give our source files index.mjs: two GraphQLError classes, and Yoga would mask our
// BAD_USER_INPUT errors as INTERNAL_SERVER_ERROR in tests only. One copy, as in production.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: { alias: { graphql: require.resolve("graphql") } },
});
