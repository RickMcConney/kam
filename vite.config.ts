import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/kam/',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Creates a separate chunk for each major vendor package
            return id.toString().split('node_modules/')[1].split('/')[0].toString();
          }
        },
      },
    },
    minify: 'esbuild',
  },
  // Optional: Removes all console.log statements to save extra bytes
  esbuild: {
    drop: ['console', 'debugger'],
  },
})
