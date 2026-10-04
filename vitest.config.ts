import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['tests/product/**/*.test.ts'],
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: ['src/main.ts'],
    reporter: ['text', 'json-summary'],
    thresholds: {
      lines: 80, functions: 80, branches: 75, statements: 80,
      'src/llm/**': { branches: 80, lines: 85 },
      'src/audit/**': { branches: 80, lines: 85 },
      'src/agents/**': { branches: 80, lines: 85 },
      'src/product/policy.ts': { branches: 80, lines: 85 },
    },
  },
} });
