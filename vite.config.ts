/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// jspoly.js has require() calls guarded by DISABLE_REQUIRE=true (dead code).
// Rolldown resolves them statically at the native level before JS transforms run,
// so we intercept at the load hook and strip them before rolldown parses the file.
// Must be in both plugins[] and worker.plugins() since the worker bundle is separate.
const jspolyPlugin = {
  name: 'stub-jspoly-dead-requires',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.includes('jspoly.js') || id.includes('?')) return null
    const code = readFileSync(id, 'utf-8')
    return { code: code.replace(/require\(['"][^'"]+['"]\)/g, '({})') }
  },
}

// The CAM pipeline runs in a Web Worker (src/workers/worker.ts), which Vite bundles
// as a separate module graph. HMR on the main thread never reaches it, so editing
// src/cam/* would leave the worker running stale code until a manual full reload.
// Force a full reload whenever a worker-graph file changes so the worker restarts.
const reloadWorkerGraph = {
  name: 'full-reload-worker-graph',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (p: unknown) => void } } }) {
    if (/\/src\/(cam|workers)\//.test(file)) {
      server.ws.send({ type: 'full-reload' })
      return []
    }
  },
}

export default defineConfig({
  base: '/kam/',
  plugins: [react(), jspolyPlugin, reloadWorkerGraph],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  worker: {
    plugins: () => [jspolyPlugin],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react'
          if (id.includes('/konva/') || id.includes('/react-konva/')) return 'konva'
          if (id.includes('/three/')) return 'three'
        },
      },
    },
  },
})
