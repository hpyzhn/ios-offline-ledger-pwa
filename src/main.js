import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { db, seedInitialData } from './db/database'

async function bootstrap() {
  // 1. 向浏览器/iOS 申请持久化存储，防止登录凭据与本地账单被系统清理
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {})
  }

  // 2. 先打开数据库，确保 Dexie Cloud 自动从本地恢复已保存的长期登录会话
  await db.open()
  await seedInitialData()

  createApp(App).mount('#app')
}

bootstrap()
