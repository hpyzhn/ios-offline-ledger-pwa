<script setup>
import { ref, watch } from 'vue'
import { db, cloudConfigured, getActiveCloudUrl, setSavedCloudUrl } from '../db/database'

const props = defineProps({
  visible: Boolean,
  currentUser: Object,
  syncState: Object
})

const emit = defineEmits(['close', 'synced'])

const urlInput = ref('')
const emailInput = ref('')
const busy = ref(false)
const tip = ref('')

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    urlInput.value = getActiveCloudUrl()
    emailInput.value = props.currentUser?.email || ''
    tip.value = ''
  }
)

function handleSaveUrl() {
  const clean = urlInput.value.trim()
  if (clean && !clean.startsWith('https://')) {
    return alert('云数据库地址必须以 https:// 开头（例如 https://xxxx.dexie.cloud）')
  }
  setSavedCloudUrl(clean)
  alert(clean ? '云同步地址已保存，页面将自动刷新生效' : '已清除云同步地址，将切回纯本地模式')
  window.location.reload()
}

async function handleLogin() {
  if (!cloudConfigured) {
    return alert('请先在下方填写并保存 Dexie Cloud 数据库地址')
  }
  busy.value = true
  tip.value = ''
  try {
    const email = emailInput.value.trim()
    if (email) {
      await db.cloud.login({ email })
    } else {
      await db.cloud.login()
    }
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
    await db.cloud.sync()
    tip.value = '云端同步完成'
    emit('synced')
  } catch (err) {
    tip.value = '同步失败：' + (err?.message || err)
  } finally {
    busy.value = false
  }
}

async function handleLogout() {
  if (!confirm('退出登录后本机将停止同步该账号数据，确定退出吗？')) return
  busy.value = true
  try {
    await db.cloud.logout()
    emit('synced')
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
            已登录：{{ currentUser.email || currentUser.userId }}
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

        <!-- 未登录：邮箱验证码登录 -->
        <div v-else-if="cloudConfigured" style="margin-bottom:16px;">
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

        <!-- Dexie Cloud 地址配置 -->
        <div style="border-top:1px solid #EAECEF;padding-top:14px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Dexie Cloud 云数据库地址（0 元/月免费版）</div>
          <div style="font-size:12px;color:#6B7280;margin-bottom:8px;line-height:1.5;">
            在电脑终端执行 <code>npx dexie-cloud create</code> 后，把得到的 <code>https://xxxx.dexie.cloud</code> 粘贴到此处保存（也可直接写入 <code>src/db/database.js</code> 供所有人自动连接）。
          </div>
          <div style="display:flex;gap:8px;">
            <input
              v-model="urlInput"
              class="form-control"
              placeholder="https://xxxxxx.dexie.cloud"
              style="flex:1;"
            />
            <button class="btn-sm primary" style="white-space:nowrap;padding:0 12px;" @click="handleSaveUrl">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
