import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { db, seedInitialData } from './db/database'

async function bootstrap() {
  try {
    // 1. 向浏览器/iOS 申请持久化存储，防止登录凭据与本地账单被系统清理
    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {})
    }

    // 2. 先打开数据库，确保 Dexie Cloud 自动从本地恢复已保存的长期登录会话
    await db.open()
    await seedInitialData()

    createApp(App).mount('#app')
  } catch (err) {
    console.error('应用初始化失败：', err)
    const root = document.getElementById('app')
    if (root) {
      root.textContent = '应用初始化失败，请刷新重试：' + (err?.message || err)
    }
  }
}

bootstrap()
