import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { cloudConfigured, db, seedInitialData } from './db/database'

async function bootstrap() {
  let stage = cloudConfigured ? '打开云账本并恢复同步' : '打开本地账本'
  try {
    // 1. 向浏览器/iOS 申请持久化存储，防止登录凭据与本地账单被系统清理
    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {})
    }

    // 2. 先打开数据库，确保 Dexie Cloud 自动从本地恢复已保存的长期登录会话
    await db.open()
    if (cloudConfigured) {
      // open() 在首次同步失败时也可能成功。直接读已提交的状态，避免订阅值尚未更新。
      const syncState = await db.table('$syncState').get('syncState')
      if (!syncState?.initiallySynced) {
        const reason = db.cloud.syncState.value?.error?.message || syncState?.error || ''
        throw new Error('首次云同步未完成。请确认联网，并核对 Dexie Cloud 提供的数据库地址。' + (reason ? ' ' + reason : ''))
      }
    }
    stage = '初始化账本数据'
    await seedInitialData()

    stage = '显示记账页面'
    createApp(App).mount('#app')
  } catch (err) {
    console.error('应用初始化失败：', err)
    const root = document.getElementById('app')
    if (root) {
      root.textContent = `应用初始化失败（${stage}）：${err?.message || err}`
      if (cloudConfigured) {
        const local = document.createElement('a')
        local.href = '?ledger=local'
        local.textContent = '打开独立的本地账本，在「云端账号同步」中修改地址'
        root.append(document.createElement('br'), local)
      }
    }
  }
}

bootstrap()
