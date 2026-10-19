import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Dev-only server for scripts/fixtures/. The root vite.config.ts aliases `@` to a
// repo-root `src` that only exists in the packaged build layout, so a fixture that
// imports packages/ui source directly needs its own resolution: `@` is the ui
// package root, matching packages/ui/tsconfig.json "paths".
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uiSrc = path.resolve(__dirname, '../../packages/ui/src')
const sdkSrc = path.resolve(__dirname, '../../packages/sdk/src')

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Rollup's alias hands a function replacement only the *matched* text, so these
    // patterns must match the entire specifier for `id` to be the full `@/lib/x` path.
    // (A bare `/^@\//` would pass just `/` and resolve to the ui root.)
    alias: [
      { find: /^@\/.*$/, replacement: (id: string) => path.resolve(uiSrc, id.slice(2)) },
      { find: /^@openchamber\/ui\/.*$/, replacement: (id: string) => path.resolve(uiSrc, id.slice('@openchamber/ui/'.length)) },
      { find: /^@openchamber\/sdk$/, replacement: path.resolve(sdkSrc, 'index.ts') },
      { find: /^@openchamber\/sdk\/.*$/, replacement: (id: string) => path.resolve(sdkSrc, id.slice('@openchamber/sdk/'.length)) },
    ],
  },
  worker: { format: 'es' },
  define: { 'process.env': {}, global: 'globalThis' },
  // The config sits in scripts/fixtures, so Vite's default allow-list roots there.
  // The fixture pulls source from packages/ui and packages/web, so allow the repo root.
  server: { fs: { allow: [path.resolve(__dirname, '../..')] } },
})