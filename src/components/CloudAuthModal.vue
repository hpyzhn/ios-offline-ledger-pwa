<script setup>
import { computed, ref, watch } from 'vue'
import {
  db, deviceDb, cloudConfigured, cloudNeedsVerification, getActiveCloudUrl, getSettings,
  isValidCloudUrl, localLedgerOnly, pendingTransferKey, setSavedCloudUrl, syncCloudLedger
} from '../db/database'
import { createLedgerBackup } from '../db/ledgerBackup.js'

const props = defineProps({
  visible: Boolean,
  currentUser: Object,
  syncState: Object,
  applyTransfer: Function
})

const emit = defineEmits(['close', 'synced'])

const urlInput = ref('')
const emailInput = ref('')
const busy = ref(false)
const tip = ref('')
const transfer = ref(null)
const copyOnSwitch = ref(true)
const authNeeded = computed(() =>
  cloudNeedsVerification(props.currentUser, props.syncState?.error) || cloudNeedsVerification(props.currentUser, tip.value)
)
const refreshTransfer = async () => {
  transfer.value = await deviceDb.records.get(pendingTransferKey())
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    urlInput.value = getActiveCloudUrl()
    emailInput.value = props.currentUser?.email || ''
    tip.value = ''
    refreshTransfer().catch(err => { tip.value = '无法读取本机迁移记录：' + err.message })
  }
)

async function handleSaveUrl() {
  if (busy.value) return
  const clean = urlInput.value.trim().replace(/\/+$/, '').toLowerCase()
  if (clean && !isValidCloudUrl(clean)) {
    return alert('云数据库地址无效：仅支持 https://xxxx.dexie.cloud 形式的 Dexie Cloud 官方地址')
  }
  const source = cloudConfigured ? getActiveCloudUrl().toLowerCase() : ''
  busy.value = true
  try {
    if (source !== clean) {
      const backup = await createLedgerBackup(db, getSettings)
      const action = copyOnSwitch.value ? '在目标账本确认后合并' : '本次仅切换账本'
      if (!confirm(`当前有 ${backup.bills.length} 条账单和 ${backup.customers.length} 个客户。切换后原账本仍保留，${action}。是否继续？`)) return
      if (copyOnSwitch.value) {
        const key = `transfer:${clean || 'local'}`
        await deviceDb.transaction('rw', deviceDb.records, async () => {
          if (await deviceDb.records.get(key)) throw new Error('目标已有待迁移记录，请先到目标账本处理，或取消勾选迁移再切换')
          await deviceDb.records.put({ key, id: crypto.randomUUID(), backup })
        })
      }
    }
    if (!setSavedCloudUrl(clean)) throw new Error('无法保存云数据库地址')
    const url = new URL(window.location.href)
    url.searchParams.delete('ledger')
    window.location.replace(url.href)
  } catch (err) {
    tip.value = '切换失败：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}

async function handleLogin() {
  if (!cloudConfigured) {
    return alert('请先在下方填写并保存 Dexie Cloud 数据库地址')
  }
  busy.value = true
  tip.value = ''
  try {
    const cur = db.cloud.currentUser?.value
    // 将重新验证固定到现有账号，避免 SDK 切换账号时清空本机云库。
    const email = cur?.isLoggedIn ? cur.email : emailInput.value.trim()
    if (cur?.isLoggedIn && !email) throw new Error('此会话未提供邮箱，请先导出备份，再重新配置账号')
    if (email) {
      await db.cloud.login({ email, grant_type: 'otp' })
    } else {
      await db.cloud.login()
    }
    await syncCloudLedger()
    tip.value = '邮箱已验证，云账本已同步'
    emit('synced')
  } catch (err) {
    tip.value = '登录未完成：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}

async function handleSyncNow() {
  if (!cloudConfigured) return
  busy.value = true
  tip.value = ''
  try {
    await syncCloudLedger()
    tip.value = '云端同步完成'
    emit('synced')
  } catch (err) {
    tip.value = '同步失败：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}

async function handleLogout() {
  if (!confirm('退出登录会清理当前云账本的本机副本。请先导出 JSON 备份，避免丢失未上传数据。确定退出吗？')) return
  busy.value = true
  try {
    await db.cloud.logout()
    emit('synced')
  } catch (err) {
    tip.value = '退出登录失败：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}

async function handleTransfer() {
  busy.value = true
  try {
    if (await props.applyTransfer()) await refreshTransfer()
  } catch (err) {
    tip.value = '迁移失败：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">关闭</button>
        <span>云端账号与多设备同步</span>
        <span style="width: 44px;"></span>
      </div>

      <div class="modal-body">
        <!-- 当前状态卡片 -->
        <div style="background:#F3F4F6;border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:13px;color:#6B7280;">当前账号状态</div>
          <div v-if="currentUser?.isLoggedIn" style="font-size:16px;font-weight:700;color:#259B5E;margin-top:4px;">
            {{ authNeeded ? '需要重新验证' : '已登录' }}：{{ currentUser.email || currentUser.userId }}
          </div>
          <div v-else style="font-size:15px;font-weight:600;color:#111827;margin-top:4px;">
            未登录（当前仅保存于本机离线库）
          </div>
          <div v-if="cloudConfigured" style="font-size:12px;color:#4B5563;margin-top:4px;">
            同步状态：{{ syncState?.phase || '就绪' }}
          </div>
        </div>

        <!-- 已登录操作 -->
        <div v-if="currentUser?.isLoggedIn" style="display:flex;gap:10px;margin-bottom:16px;">
          <button class="btn-block btn-primary" :disabled="busy" @click="handleSyncNow">
            {{ busy ? '同步中...' : '立即云端同步' }}
          </button>
          <button class="btn-block btn-secondary" :disabled="busy" @click="handleLogout">
            退出登录
          </button>
        </div>
        <button v-if="currentUser?.isLoggedIn" class="btn-block btn-secondary" :disabled="busy" @click="handleLogin">
          重新验证当前邮箱
        </button>

        <!-- 未登录：邮箱验证码登录 -->
        <div v-if="cloudConfigured && !currentUser?.isLoggedIn" style="margin-bottom:16px;">
          <div class="form-group">
            <label class="form-label">输入邮箱接收免费登录验证码（支持手机与电脑同号同步）</label>
            <input
              v-model="emailInput"
              type="email"
              class="form-control"
              placeholder="例如：yourname@qq.com 或 gmail.com"
            />
          </div>
          <button class="btn-block btn-primary" style="width:100%;" :disabled="busy" @click="handleLogin">
            {{ busy ? '正在打开验证...' : '发送验证码并登录云同步' }}
          </button>
        </div>

        <div v-if="tip" style="font-size:13px;color:#259B5E;margin-bottom:12px;">{{ tip }}</div>
        <button v-if="transfer" class="btn-block btn-primary" :disabled="busy || (cloudConfigured && !currentUser?.isLoggedIn)" @click="handleTransfer">
          预览并合并待迁移账本（{{ transfer.backup.bills.length }} 条账单）
        </button>

        <!-- Dexie Cloud 地址配置 -->
        <div style="border-top:1px solid #EAECEF;padding-top:14px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Dexie Cloud 云数据库地址（0 元/月免费版）</div>
          <div style="font-size:12px;color:#6B7280;margin-bottom:8px;line-height:1.5;">
            在电脑终端执行 <code>npx dexie-cloud create</code> 后，把得到的 <code>https://xxxx.dexie.cloud</code> 粘贴到此处保存（或构建时通过环境变量 <code>VITE_DEXIE_CLOUD_URL</code> 注入，供所有人自动连接）。
          </div>
          <div style="display:flex;gap:8px;">
            <input
              v-model="urlInput"
              class="form-control"
              placeholder="https://xxxxxx.dexie.cloud"
              style="flex:1;"
            />
            <button class="btn-sm primary" style="white-space:nowrap;padding:0 12px;" :disabled="busy" @click="handleSaveUrl">
              保存
            </button>
          </div>
          <label><input v-model="copyOnSwitch" type="checkbox" /> 切换地址时准备迁移当前账本</label>
        </div>
      </div>
    </div>
  </div>
</template>
