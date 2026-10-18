import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    publicDir: 'public',
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          runtime: resolve('src/runtime/index.ts'),
          cli: resolve('src/cli/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    build: { minify: 'esbuild' },
    resolve: { alias: { '@': resolve('src/renderer') } },
    plugins: [
      react(),
      tailwindcss(),
      // Only the dev server needs HMR connections; production keeps connect-src at 'self'.
      {
        name: 'panelab-dev-csp',
        apply: 'serve',
        transformIndexHtml: (html) =>
          html.replace(
            "connect-src 'self'",
            "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
          ),
      },
    ],
    server: { host: '127.0.0.1' },
  },
})
