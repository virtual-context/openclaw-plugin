import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plugin is ESM (package.json "type": "module"); vitest handles natively.
    environment: "node",
    // Each test file runs in its own context so fetch mocks don't leak between specs.
    isolate: true,
    // Reasonable defaults; override in individual specs as needed.
    testTimeout: 10000,
    hookTimeout: 10000,
    include: ["tests/**/*.test.js"],
    exclude: ["node_modules/**", "**/.git/**"],
  },
});
