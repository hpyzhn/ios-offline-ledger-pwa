<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import {
  db,
  cloudConfigured,
  getSettings,
  saveSettings,
  generateNextBillNo,
  createDefaultExportTemplate,
  DEFAULT_PRODUCTS
} from './db/database'
import LedgerView from './views/LedgerView.vue'
import StatsView from './views/StatsView.vue'
import ManageView from './views/ManageView.vue'
import BillFormModal from './components/BillFormModal.vue'
import ReceiptPreview from './components/ReceiptPreview.vue'
import CloudAuthModal from './components/CloudAuthModal.vue'
import AdminPanelModal from './components/AdminPanelModal.vue'
import SmartImportModal from './components/SmartImportModal.vue'

const activeTab = ref('ledger')
const currentMonth = ref(new Date().toISOString().slice(0, 7))
const isOnline = ref(navigator.onLine)

const customers = ref([])
const products = ref([])
const bills = ref([])
const settings = ref({})

const showBillModal = ref(false)
const editingBill = ref(null)
const defaultBillCustomer = ref('')
const showPreview = ref(false)
const previewBill = ref(null)
const showAuthModal = ref(false)
const showAdminModal = ref(false)
const showSmartImport = ref(false)
const currentUser = ref(null)
const syncState = ref(null)
const pendingSyncCount = ref(0)
const syncBanner = ref('')

async function loadData() {
  customers.value = await db.customers.toArray()
  products.value = await db.products.toArray()
  bills.value = await db.bills
    .where('month')
    .equals(currentMonth.value)
    .reverse()
    .sortBy('date')
  settings.value = await getSettings()
  pendingSyncCount.value = await db.bills.where('syncStatus').equals('pending').count()
}

// 联网后自动检测本地是否有未同步的离线数据，并自动上传至云盘
let syncingPending = false
async function autoCheckAndUploadOfflineData(manual = false) {
  if (syncingPending) return
  const pendingBills = await db.bills.where('syncStatus').equals('pending').toArray()
  pendingSyncCount.value = pendingBills.length

  if (!navigator.onLine) {
    if (manual) syncBanner.value = '当前处于离线状态，数据已安全保存在本机，联网后将自动上传。'
    return
  }
  if (!cloudConfigured) {
    if (manual) alert('尚未配置 Dexie Cloud 云数据库地址，请先在「云同步」中配置。')
    return
  }
  if (!currentUser.value?.isLoggedIn) {
    if (pendingBills.length > 0) {
      syncBanner.value = `网络已连接，检测到 ${pendingBills.length} 条离线账单待上传，请点顶部「登录同步」。`
    }
    return
  }
  if (pendingBills.length === 0 && !manual) return

  syncingPending = true
  syncBanner.value = `检测到 ${pendingBills.length} 条离线未同步账单，正在自动上传云端...`
  try {
    await db.cloud.sync({ wait: true })
    if (pendingBills.length > 0) {
      await db.bills.where('syncStatus').equals('pending').modify({ syncStatus: 'synced' })
      await db.cloud.sync({ wait: true })
    }
    await loadData()
    syncBanner.value = pendingBills.length > 0
      ? `已自动将 ${pendingBills.length} 条离线账单上传并同步到云端`
      : '云端与本地数据已完全同步'
    setTimeout(() => { syncBanner.value = '' }, 4000)
  } catch (err) {
    syncBanner.value = '自动上传失败，将在下次联网重试：' + (err?.message || err)
  } finally {
    syncingPending = false
  }
}

watch(currentMonth, loadData)

function syncOnline() {
  isOnline.value = navigator.onLine
  if (isOnline.value) {
    autoCheckAndUploadOfflineData(false)
  } else {
    syncBanner.value = '当前已断网：仍可正常新增/修改账单，联网后自动上传云端'
    setTimeout(() => { if (!navigator.onLine) syncBanner.value = '' }, 4000)
  }
}

function handleVisibility() {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    autoCheckAndUploadOfflineData(false)
  }
}

let subUser = null
let subSync = null
let subComplete = null

onMounted(() => {
  loadData()
  window.addEventListener('online', syncOnline)
  window.addEventListener('offline', syncOnline)

  document.addEventListener('visibilitychange', handleVisibility)
  if (db.cloud?.currentUser) {
    subUser = db.cloud.currentUser.subscribe((u) => {
      currentUser.value = u
      if (u?.isLoggedIn && navigator.onLine) {
        autoCheckAndUploadOfflineData(false)
      }
    })
  }
  if (db.cloud?.syncState) {
    subSync = db.cloud.syncState.subscribe((s) => {
      syncState.value = s
    })
  }
  if (db.cloud?.events?.syncComplete) {
    subComplete = db.cloud.events.syncComplete.subscribe(() => {
      loadData()
    })
  }
})

onUnmounted(() => {
  window.removeEventListener('online', syncOnline)
  window.removeEventListener('offline', syncOnline)
  document.removeEventListener('visibilitychange', handleVisibility)
  subUser?.unsubscribe?.()
  subSync?.unsubscribe?.()
  subComplete?.unsubscribe?.()
})

function openCreateBill(custName = '') {
  editingBill.value = null
  defaultBillCustomer.value = custName || customers.value[0]?.name || ''
  showBillModal.value = true
}

function openEditBill(bill) {
  editingBill.value = bill
  showBillModal.value = true
}

async function handleSaveBill(payload) {
  const now = Date.now()
  const isSyncedReady = navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn
  const syncFlag = isSyncedReady ? 'synced' : 'pending'

  if (payload.id) {
    await db.bills.update(payload.id, { ...payload, syncStatus: syncFlag, updatedAt: now })
  } else {
    const billNo = await generateNextBillNo(payload.date)
    await db.bills.add({
      ...payload,
      billNo,
      syncStatus: syncFlag,
      createdAt: now,
      updatedAt: now
    })
  }
  showBillModal.value = false
  if (payload.month !== currentMonth.value) currentMonth.value = payload.month
  else await loadData()

  if (isSyncedReady) {
    db.cloud.sync().catch(() => {})
  }
}

async function handleConfirmSmartImport(records) {
  const now = Date.now()
  const isSyncedReady = navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn
  const syncFlag = isSyncedReady ? 'synced' : 'pending'

  let createdCustomers = 0
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    // 1. 如客户不存在，自动创建新客户并把导入的类目设为该客户固定类目
    let cust = await db.customers.where('name').equals(rec.customerName).first()
    if (!cust) {
      await db.customers.add({
        name: rec.customerName,
        categories: rec.items.map((it) => ({
          name: it.name,
          unit: it.unit || '条',
          price: Number(it.price) || 0,
          enabled: true
        })),
        exportTemplate: createDefaultExportTemplate(settings.value.companyName),
        createdAt: now + i
      })
      createdCustomers++
    } else {
      // 已有客户但包含新类目时，自动补进固定类目
      const list = Array.isArray(cust.categories) ? [...cust.categories] : []
      let changed = false
      rec.items.forEach((it) => {
        if (!list.some((c) => c.name === it.name)) {
          list.push({ name: it.name, unit: it.unit || '条', price: Number(it.price) || 0, enabled: true })
          changed = true
        }
      })
      if (changed) {
        await db.customers.update(cust.id, { categories: list })
      }
    }

    // 2. 写入账单
    const billNo = await generateNextBillNo(rec.date)
    await db.bills.add({
      billNo,
      customerName: rec.customerName,
      date: rec.date,
      month: rec.month,
      paymentMethod: rec.paymentMethod || '月结挂账',
      status: rec.status || 'pending',
      remark: rec.remark || '',
      items: rec.items,
      totalAmount: Number(rec.totalAmount) || 0,
      syncStatus: syncFlag,
      createdAt: now + i,
      updatedAt: now + i
    })
  }

  showSmartImport.value = false
  await loadData()
  if (isSyncedReady) {
    db.cloud.sync().catch(() => {})
  }
  alert(`成功导入 ${records.length} 笔账单` + (createdCustomers > 0 ? `（同时自动新建 ${createdCustomers} 个客户档案）` : ''))
}

async function handleDeleteBill(bill) {
  if (!confirm(`确定删除 ${bill.customerName}（${bill.date}）的单据吗？`)) return
  await db.bills.delete(bill.id)
  await loadData()
}

async function handleToggleVerify(bill) {
  const nextStatus = bill.status === 'verified' ? 'pending' : 'verified'
  const syncFlag = navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn ? 'synced' : 'pending'
  await db.bills.update(bill.id, { status: nextStatus, syncStatus: syncFlag, updatedAt: Date.now() })
  if (previewBill.value?.id === bill.id) {
    previewBill.value = { ...previewBill.value, status: nextStatus }
  }
  await loadData()
}

function openPreview(bill) {
  previewBill.value = bill
  showPreview.value = true
}

// 记一笔弹窗内快捷新增固定类目
async function handleQuickAddCategory({ customerName, category }) {
  const cust = await db.customers.where('name').equals(customerName).first()
  if (!cust) return
  const list = Array.isArray(cust.categories) ? [...cust.categories] : []
  if (!list.some((c) => c.name === category.name)) {
    list.push(category)
    await db.customers.update(cust.id, { categories: list })
    await loadData()
  }
}

// 后台客户与模板管理
async function handleAddCustomer(name) {
  const exists = await db.customers.where('name').equals(name).first()
  if (exists) return alert('已存在同名客户')
  await db.customers.add({
    name,
    categories: DEFAULT_PRODUCTS.slice(0, 3).map((p) => ({
      name: p.name,
      unit: p.unit,
      price: p.defaultPrice,
      enabled: true
    })),
    exportTemplate: createDefaultExportTemplate(settings.value.companyName),
    createdAt: Date.now()
  })
  await loadData()
}

async function handleUpdateCustomerCategories({ customerId, categories }) {
  await db.customers.update(customerId, { categories })
  await loadData()
}

async function handleSaveCustomerTemplate({ customerId, exportTemplate }) {
  await db.customers.update(customerId, { exportTemplate })
  await loadData()
  alert('该客户的专属输出格式已保存')
}

async function handleDeleteCustomer(cust) {
  if (!confirm(`确定删除客户「${cust.name}」吗？（不会删除已录入的历史账单）`)) return
  await db.customers.delete(cust.id)
  await loadData()
}

async function handleSaveSettings(data) {
  await saveSettings(data)
  await loadData()
}

async function handleBackupJson() {
  const dump = {
    version: 2,
    exportedAt: new Date().toISOString(),
    customers: await db.customers.toArray(),
    products: await db.products.toArray(),
    bills: await db.bills.toArray(),
    settings: await getSettings()
  }
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `记账本备份_${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function handleRestoreJson(rawText) {
  try {
    const parsed = JSON.parse(rawText)
    if (!Array.isArray(parsed.bills)) return alert('备份文件格式不正确')
    if (!confirm('导入备份将覆盖当前所有客户模板和账单，确定继续吗？')) return
    await db.transaction('rw', db.customers, db.products, db.bills, db.settings, async () => {
      if (Array.isArray(parsed.customers)) {
        await db.customers.clear()
        await db.customers.bulkAdd(parsed.customers)
      }
      if (Array.isArray(parsed.products)) {
        await db.products.clear()
        await db.products.bulkAdd(parsed.products)
      }
      await db.bills.clear()
      await db.bills.bulkAdd(parsed.bills)
      if (parsed.settings) await saveSettings(parsed.settings)
    })
    await loadData()
    alert('本地数据恢复成功')
  } catch (err) {
    alert('导入失败：' + err.message)
  }
}
</script>

<template>
  <div class="app-shell">
    <LedgerView
      v-if="activeTab === 'ledger'"
      v-model:month="currentMonth"
      :bills="bills"
      :customers="customers"
      :is-online="isOnline"
      :current-user="currentUser"
      :pending-sync-count="pendingSyncCount"
      :sync-banner="syncBanner"
      @open-auth="showAuthModal = true"
      @open-admin="showAdminModal = true"
      @open-smart-import="showSmartImport = true"
      @create="openCreateBill"
      @edit="openEditBill"
      @delete="handleDeleteBill"
      @toggle-verify="handleToggleVerify"
      @preview="openPreview"
    />

    <StatsView
      v-else-if="activeTab === 'stats'"
      v-model:month="currentMonth"
      :bills="bills"
      :customers="customers"
      :settings="settings"
      @save-customer-template="handleSaveCustomerTemplate"
    />

    <ManageView
      v-else
      :customers="customers"
      :products="products"
      :settings="settings"
      :current-user="currentUser"
      :pending-sync-count="pendingSyncCount"
      :sync-banner="syncBanner"
      @open-auth="showAuthModal = true"
      @open-admin="showAdminModal = true"
      @open-smart-import="showSmartImport = true"
      @add-customer="handleAddCustomer"
      @update-customer-categories="handleUpdateCustomerCategories"
      @delete-customer="handleDeleteCustomer"
      @save-settings="handleSaveSettings"
      @backup-json="handleBackupJson"
      @restore-json="handleRestoreJson"
    />

    <nav class="bottom-nav">
      <button class="nav-item" :class="{ active: activeTab === 'ledger' }" @click="activeTab = 'ledger'">
        <span style="font-size:18px;">📄</span>
        <span>明细</span>
      </button>
      <button class="nav-item" :class="{ active: activeTab === 'stats' }" @click="activeTab = 'stats'">
        <span style="font-size:18px;">◔</span>
        <span>结算统计</span>
      </button>
      <button class="nav-item" :class="{ active: activeTab === 'manage' }" @click="activeTab = 'manage'">
        <span style="font-size:18px;">⚙</span>
        <span>客户设置</span>
      </button>
    </nav>

    <BillFormModal
      :visible="showBillModal"
      :customers="customers"
      :products="products"
      :editing-bill="editingBill"
      :default-customer-name="defaultBillCustomer"
      :default-date="new Date().toISOString().slice(0, 10)"
      @close="showBillModal = false"
      @save="handleSaveBill"
      @quick-add-category="handleQuickAddCategory"
    />

    <ReceiptPreview
      :visible="showPreview"
      :bill="previewBill"
      :settings="settings"
      @close="showPreview = false"
      @toggle-verify="handleToggleVerify"
    />
    <SmartImportModal
      :visible="showSmartImport"
      :customers="customers"
      :products="products"
      @close="showSmartImport = false"
      @confirm-import="handleConfirmSmartImport"
    />

    <AdminPanelModal
      :visible="showAdminModal"
      :settings="settings"
      :pending-sync-count="pendingSyncCount"
      @close="showAdminModal = false"
      @updated="loadData"
      @force-sync="autoCheckAndUploadOfflineData(true)"
    />

    <CloudAuthModal
      :visible="showAuthModal"
      :current-user="currentUser"
      :sync-state="syncState"
      @close="showAuthModal = false"
      @synced="loadData"
    />
  </div>
</template>
