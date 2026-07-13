import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@mcp-interlab/core'],
  onSuccess: 'node scripts/copy-corpus.mjs'
});
