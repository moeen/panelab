import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer') } },
  test: {
    globals: false,
    allowOnly: false,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
    },
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        plugins: [react(), tailwindcss()],
        optimizeDeps: {
          include: [
            '@base-ui/react/dialog',
            '@base-ui/react/button',
            '@base-ui/react/checkbox',
            '@base-ui/react/tabs',
            'lucide-react',
            'class-variance-authority',
            'clsx',
            'tailwind-merge',
            'zod',
          ],
        },
        test: {
          name: 'renderer',
          api: { host: '127.0.0.1', port: 0 },
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          browser: {
            viewport: { width: 960, height: 720 },
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
