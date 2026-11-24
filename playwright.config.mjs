import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4176/ios-offline-ledger-pwa/'

export default defineConfig({
  testDir: './tests/browser',
  workers: 2,
  use: { baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
  projects: [
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'], browserName: 'webkit' } }
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4176 --strictPort',
    url: baseURL
  }
})
