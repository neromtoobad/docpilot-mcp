import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // Run tests serially — the InMemoryTransport pair is per-test, and
    // the global MCP "ready" log line is safe to share.
    fileParallelism: false,
  },
});
