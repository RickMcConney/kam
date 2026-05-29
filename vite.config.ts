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

export default defineConfig({
  base: '/kam/',
  plugins: [react(), jspolyPlugin],
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
