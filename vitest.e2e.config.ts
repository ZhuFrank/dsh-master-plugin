import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['e2e/**/*.e2e.test.ts'], setupFiles: ['e2e/repo-guard.setup.ts'], pool: 'forks', testTimeout: 240_000, hookTimeout: 120_000, fileParallelism: false, silent: false, reporters: ["verbose"] } })
