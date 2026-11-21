import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const REPO_BASE = '/ios-offline-ledger-pwa/'

export default defineConfig({
  base: REPO_BASE,
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        id: REPO_BASE,
        name: '离线电子记账本',
        short_name: '记账本',
        description: '支持离线记账、Dexie Cloud 多设备云同步与留香东江原版结算表导出',
        start_url: REPO_BASE,
        scope: REPO_BASE,
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#2EB872',
        background_color: '#F5F6F7',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: `${REPO_BASE}index.html`
      }
    })
  ]
})
