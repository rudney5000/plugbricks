import { defineConfig } from "vitest/config";

// Many tests run the CLI, compose a graph or start Docker, and the Windows runners are slow: a test that takes 6 to 11 s
// there is normal. Vitest 2 let a synchronous test (spawnSync) run past its timeout without noticing; vitest 5 does not.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
