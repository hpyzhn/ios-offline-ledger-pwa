<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import {
  db,
  cloudConfigured,
  getSettings,
  saveSettings,
  generateNextBillNo,
  createDefaultExportTemplate,
  verifyAdminPin,
  getAdminPinLockStatus,
  isAdminPinDefault,
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

// 使用本地时区格式化日期，避免 toISOString() 在 UTC+8 凌晨错一天/错一月
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 校验真实日历日期（正则拦不住 2026-02-30 / 2026-13-40 这类非法日期，入库后账单会“消失”在无效月份）
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

// 备份中的客户档案结构校验：类目/输出模板形状损坏会导致记账弹窗与 Excel 导出直接崩溃
function isValidBackupCustomer(c) {
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) return false
  if (c.categories !== undefined) {
    if (!Array.isArray(c.categories)) return false
    if (c.categories.some((cat) => !cat || typeof cat !== 'object' || typeof cat.name !== 'string' || !cat.name.trim() || (cat.price !== undefined && (!Number.isFinite(Number(cat.price)) || Number(cat.price) < 0)))) return false
  }
  if (c.exportTemplate !== undefined) {
    const t = c.exportTemplate
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false
    if (t.tailColumns !== undefined && !Array.isArray(t.tailColumns)) return false
    if (t.extraStatusFields !== undefined && !Array.isArray(t.extraStatusFields)) return false
  }
  return true
}

const currentMonth = ref(localDateStr().slice(0, 7))
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

let loadDataSeq = 0
async function loadData() {
  const seq = ++loadDataSeq
  const month = currentMonth.value
  const [custs, prods, monthBills, profile, pendingCount] = await Promise.all([
    db.customers.toArray(),
    db.products.toArray(),
    db.bills.where('month').equals(month).sortBy('date'),
    getSettings(),
    db.bills.where('syncStatus').equals('pending').count()
  ])
  // 序号守卫：丢弃过期的慢请求结果，防止旧月份/旧快照覆盖新数据
  if (seq !== loadDataSeq) return
  customers.value = custs
  products.value = prods
  bills.value = monthBills
  settings.value = profile
  pendingSyncCount.value = pendingCount
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

  if (syncingPending) return
  syncingPending = true
  syncBanner.value = `检测到 ${pendingBills.length} 条离线未同步账单，正在自动上传云端...`
  try {
    await db.cloud.sync({ wait: true })
    if (pendingBills.length > 0) {
      await db.transaction('rw', db.bills, async () => {
        for (const snapshot of pendingBills) {
          const latest = await db.bills.get(snapshot.id)
          if (latest?.syncStatus === 'pending' && JSON.stringify(latest) === JSON.stringify(snapshot)) {
            await db.bills.update(snapshot.id, { syncStatus: 'synced' })
          }
        }
      })
      await db.cloud.sync({ wait: true })
    }
    await loadData()
    syncBanner.value = pendingSyncCount.value > 0
      ? `同步期间有新的修改，仍有 ${pendingSyncCount.value} 条账单待确认上传`
      : pendingBills.length > 0
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

const billSaving = ref(false)
async function handleSaveBill(payload) {
  // 防重复提交：快速双击/并发触发只允许一次写入，避免产生重复账单
  if (billSaving.value) return
  billSaving.value = true
  try {
    const now = Date.now()
    const isSyncedReady = navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn
    const { baseUpdatedAt, ...changes } = payload
    // 单号生成放在事务外，避免事务等待非 IndexedDB 异步而提前提交
    const billNo = payload.id ? null : await generateNextBillNo(payload.date)

    await db.transaction('rw', db.bills, async () => {
      if (payload.id) {
        const latest = await db.bills.get(payload.id)
        if (!latest) {
          throw Object.assign(new Error('该账单不存在或已被其他设备删除，请刷新列表后重试'), { code: 'NOT_FOUND' })
        }
        // 乐观并发控制：基线版本不一致说明其他窗口/设备已修改，拒绝盲写覆盖
        if ((latest.updatedAt || 0) !== (baseUpdatedAt || 0)) {
          throw Object.assign(new Error('该账单已被其他窗口或设备修改，为避免覆盖他人数据已取消保存，请重新打开编辑'), { code: 'CONFLICT' })
        }
        await db.bills.update(payload.id, { ...changes, syncStatus: 'pending', updatedAt: now })
      } else {
        await db.bills.add({
          ...changes,
          billNo,
          syncStatus: 'pending',
          createdAt: now,
          updatedAt: now
        })
      }
    })
    showBillModal.value = false
    if (payload.month !== currentMonth.value) currentMonth.value = payload.month
    else await loadData()

    if (isSyncedReady) {
      autoCheckAndUploadOfflineData(false)
    }
  } catch (err) {
    alert('保存失败：' + (err?.message || err))
    if (err?.code === 'CONFLICT' || err?.code === 'NOT_FOUND') {
      showBillModal.value = false
      editingBill.value = null
    }
    await loadData()
  } finally {
    billSaving.value = false
  }
}

const importing = ref(false)
async function handleConfirmSmartImport(records) {
  if (importing.value) return
  importing.value = true
  try {
    const now = Date.now()
    const isSyncedReady = navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn
    const syncFlag = 'pending'

    let createdCustomers = 0
    // 前置校验 + 事务外预生成单号（避免事务内等待非 IDB 异步导致提前提交）
    if (records.some((r) => !r || typeof r.customerName !== 'string' || !r.customerName.trim() || !isValidDateStr(r.date))) {
      throw new Error('导入数据缺少有效的客户名或真实日期（YYYY-MM-DD）')
    }
    const billNos = []
    for (const rec of records) billNos.push(await generateNextBillNo(rec.date))

    await db.transaction('rw', db.customers, db.bills, async () => {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        if (!rec.items?.length || rec.items.some(i => !Number.isFinite(Number(i.qty)) || Number(i.qty) <= 0 || !Number.isFinite(Number(i.price)) || Number(i.price) < 0)) throw new Error('导入数据存在无效的数量或单价（数量需大于0，单价需为非负数）')
        rec.totalAmount = Number(rec.items.reduce((sum, i) => sum + Number(i.qty) * Number(i.price), 0).toFixed(2))
        const existing = await db.bills.where('date').equals(rec.date).toArray()
        const normalizeItems = (items) =>
          [...(items || [])]
            .map((i) => `${i.name}|${i.qty}|${i.price}|${i.unit || ''}`)
            .sort()
            .join(';;')
        if (existing.some((b) => b.customerName === rec.customerName && normalizeItems(b.items) === normalizeItems(rec.items) && (b.remark || '') === (rec.remark || ''))) {
          throw new Error('重复账单（同客户同日期同明细）：' + rec.customerName + ' ' + rec.date)
        }
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
        await db.bills.add({
          billNo: billNos[i],
          customerName: rec.customerName,
          date: rec.date,
          month: rec.date.slice(0, 7),
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

    })
    showSmartImport.value = false
    await loadData()
    if (isSyncedReady) {
      autoCheckAndUploadOfflineData(false)
    }
    alert(`成功导入 ${records.length} 笔账单` + (createdCustomers > 0 ? `（同时自动新建 ${createdCustomers} 个客户档案）` : ''))
  } catch (err) {
    alert('导入失败：' + (err?.message || err))
  } finally { importing.value = false }
}

let deletingBill = false
async function handleDeleteBill(bill) {
  if (deletingBill) return
  if (!confirm(`确定删除 ${bill.customerName}（${bill.date}）的单据吗？`)) return
  deletingBill = true
  try {
    // 以库内最新状态为准做管理员校验，防止 UI 快照过期绕过已核销保护
    const latest = await db.bills.get(bill.id)
    if (!latest) {
      alert('该账单已被删除，列表已刷新')
      await loadData()
      return
    }
    let adminApproved = false
    if (latest.status === 'verified') {
      adminApproved = await requireAdminForAction('删除已核销单据')
      if (!adminApproved) return
    }
    // 事务内二次校验：确认弹窗/口令输入期间若被其他窗口核销，必须重新走管理员校验
    const result = await db.transaction('rw', db.bills, async () => {
      const cur = await db.bills.get(bill.id)
      if (!cur) return { missing: true }
      if (cur.status === 'verified' && !adminApproved) return { conflict: true }
      await db.bills.delete(bill.id)
      return {}
    })
    if (result.missing) {
      alert('该账单已被删除，列表已刷新')
      await loadData()
      return
    }
    if (result.conflict) {
      alert('该账单刚被其他窗口核销，删除需管理员口令，请重试')
      await loadData()
      return
    }
    if (previewBill.value?.id === bill.id) {
      showPreview.value = false
      previewBill.value = null
    }
    await loadData()
  } catch (err) {
    alert('删除失败：' + (err?.message || err))
  } finally {
    deletingBill = false
  }
}

async function requireAdminForAction(actionLabel) {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return false
  const input = window.prompt(`此操作需要管理员口令（${actionLabel}）：`)
  if (input === null) return false
  const ok = await verifyAdminPin(input)
  if (!ok) {
    // 失败计数与锁定由 database.js 全局持久化管理，此处仅作提示
    alert(getAdminPinLockStatus().locked ? '口令尝试过于频繁已被锁定，请稍后再试' : '管理员口令错误，操作已取消')
    return false
  }
  // 出厂默认口令已随开源代码公开：仍在使用时禁止执行敏感操作，引导先修改口令
  if (await isAdminPinDefault()) {
    alert('当前仍在使用出厂默认口令（8888），请先进入「管理员后台」修改口令后再执行该操作')
    return false
  }
  return true
}

let togglingVerify = false
async function handleToggleVerify(bill) {
  if (togglingVerify) return
  togglingVerify = true
  try {
    // 读取库内最新状态，而不是 UI 旧快照，防止并发核销/撤回方向错误
    const latest = await db.bills.get(bill.id)
    if (!latest) {
      alert('该账单不存在或已被删除，列表已刷新')
      await loadData()
      return
    }
    let adminApproved = false
    if (latest.status === 'verified') {
      adminApproved = await requireAdminForAction('撤回核销')
      if (!adminApproved) return
    }
    const result = await db.transaction('rw', db.bills, async () => {
      const cur = await db.bills.get(bill.id)
      if (!cur) return { missing: true }
      // 口令确认期间若被其他窗口核销，撤回必须重新走管理员校验
      if (cur.status === 'verified' && !adminApproved) return { conflict: true }
      const nextStatus = cur.status === 'verified' ? 'pending' : 'verified'
      await db.bills.update(bill.id, { status: nextStatus, syncStatus: 'pending', updatedAt: Date.now() })
      return { nextStatus }
    })
    if (result.missing) {
      alert('该账单不存在或已被删除，列表已刷新')
      await loadData()
      return
    }
    if (result.conflict) {
      alert('该账单刚被其他窗口核销，撤回需管理员口令，请重试')
      await loadData()
      return
    }
    if (previewBill.value?.id === bill.id) {
      previewBill.value = { ...previewBill.value, status: result.nextStatus }
    }
    await loadData()
    autoCheckAndUploadOfflineData(false)
  } catch (err) {
    alert('核销状态更新失败：' + (err?.message || err))
  } finally {
    togglingVerify = false
  }
}

function openPreview(bill) {
  previewBill.value = bill
  showPreview.value = true
}

// 记一笔弹窗内快捷新增固定类目（事务内读-改-写，防止与并发导入/管理操作互相覆盖）
async function handleQuickAddCategory({ customerName, category }) {
  try {
    if (!category || typeof category.name !== 'string' || !category.name.trim() || !Number.isFinite(Number(category.price)) || Number(category.price) < 0) {
      return alert('类目数据无效：名称不能为空且单价必须为非负数')
    }
    await db.transaction('rw', db.customers, async () => {
      const cust = await db.customers.where('name').equals(customerName).first()
      if (!cust) return
      const list = Array.isArray(cust.categories) ? [...cust.categories] : []
      if (list.some((c) => c.name === category.name)) return
      list.push({ ...category, name: category.name.trim(), price: Number(category.price) })
      await db.customers.update(cust.id, { categories: list })
    })
    await loadData()
  } catch (err) {
    alert('新增类目失败：' + (err?.message || err))
  }
}

// 后台客户与模板管理
async function handleAddCustomer(name) {
  const cleanName = String(name || '').trim()
  if (!cleanName) return alert('请输入合作商家/客户名称')
  try {
    // 查重与写入放在同一事务：防止双击/多窗口并发创建同名客户造成记录冲突
    await db.transaction('rw', db.customers, async () => {
      const exists = await db.customers.where('name').equals(cleanName).first()
      if (exists) throw new Error('已存在同名客户')
      await db.customers.add({
        name: cleanName,
        categories: DEFAULT_PRODUCTS.slice(0, 3).map((p) => ({
          name: p.name,
          unit: p.unit,
          price: p.defaultPrice,
          enabled: true
        })),
        exportTemplate: createDefaultExportTemplate(settings.value.companyName),
        createdAt: Date.now()
      })
    })
    await loadData()
  } catch (err) {
    alert(err?.message || String(err))
    await loadData()
  }
}

// 类目变更按“操作指令”在事务内应用到最新数据，杜绝旧快照整数组回写造成的丢失更新
async function handleUpdateCustomerCategories({ customerId, op, category, index, delta, price, name }) {
  try {
    await db.transaction('rw', db.customers, async () => {
      const cust = await db.customers.get(customerId)
      if (!cust) throw new Error('该客户不存在或已被删除，请刷新后重试')
      const list = Array.isArray(cust.categories) ? [...cust.categories] : []
      if (op === 'add') {
        if (!category || !category.name) throw new Error('类目数据无效')
        if (list.some((c) => c.name === category.name)) throw new Error('该客户已存在同名类目')
        list.push(category)
      } else if (op === 'updatePrice') {
        if (!list[index]) throw new Error('该类目已被其他窗口删除，请刷新后重试')
        // 名称守卫：并发增删导致下标错位时，拒绝把价格写到错误的类目上
        if (name !== undefined && list[index].name !== name) throw new Error('类目列表已被其他窗口修改，请刷新后重试')
        const p = Number(price)
        if (!Number.isFinite(p) || p < 0) throw new Error('单价必须是有效的非负数')
        list[index] = { ...list[index], price: p }
      } else if (op === 'move') {
        const t = index + delta
        if (index < 0 || index >= list.length || t < 0 || t >= list.length) return
        if (name !== undefined && list[index].name !== name) throw new Error('类目列表已被其他窗口修改，请刷新后重试')
        const tmp = list[index]
        list[index] = list[t]
        list[t] = tmp
      } else if (op === 'remove') {
        if (index < 0 || index >= list.length) throw new Error('该类目已被其他窗口删除，请刷新后重试')
        if (name !== undefined && list[index].name !== name) throw new Error('类目列表已被其他窗口修改，请刷新后重试')
        list.splice(index, 1)
      } else {
        throw new Error('未知的类目操作')
      }
      await db.customers.update(customerId, { categories: list })
    })
    await loadData()
  } catch (err) {
    alert(err?.message || String(err))
    await loadData()
  }
}

async function handleSaveCustomerTemplate({ customerId, exportTemplate }) {
  try {
    const updated = await db.customers.update(customerId, { exportTemplate })
    if (!updated) {
      alert('该客户不存在或已被删除，模板未保存')
      await loadData()
      return
    }
    await loadData()
    alert('该客户的专属输出格式已保存')
  } catch (err) {
    alert('模板保存失败：' + (err?.message || err))
  }
}

async function handleDeleteCustomer(cust) {
  if (!confirm(`确定删除客户「${cust.name}」吗？（不会删除已录入的历史账单）`)) return
  try {
    await db.customers.delete(cust.id)
    await loadData()
  } catch (err) {
    alert('删除客户失败：' + (err?.message || err))
  }
}

async function handleSaveSettings(data) {
  try {
    await saveSettings(data)
    await loadData()
    alert('默认结算表抬头已保存')
  } catch (err) {
    alert('设置保存失败：' + (err?.message || err))
  }
}

async function handleBackupJson() {
  try {
    // 管理员凭据属于本机安全数据，不随备份文件导出/迁移
    const settingsDump = await getSettings()
    delete settingsDump.adminPin
    delete settingsDump.adminPinHash
    delete settingsDump.adminPinSalt
    delete settingsDump.adminPinIsDefault
    const dump = {
      version: 2,
      exportedAt: new Date().toISOString(),
      customers: await db.customers.toArray(),
      products: await db.products.toArray(),
      bills: await db.bills.toArray(),
      settings: settingsDump
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `记账本备份_${localDateStr()}.json`
    a.click()
    if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 1000)
    else URL.revokeObjectURL(url)
  } catch (err) {
    alert('导出备份失败：' + (err?.message || err))
  }
}

async function handleRestoreJson(rawText) {
  try {
    const parsed = JSON.parse(rawText)
    if (!Array.isArray(parsed.bills) || parsed.bills.some((b) => !b || typeof b !== 'object' || typeof b.customerName !== 'string' || !b.customerName.trim())) {
      return alert('备份文件格式不正确：缺少有效的 bills 账单数组')
    }
    // 逐条校验日期与明细，坏数据在清库前就拒绝，避免恢复后账单“消失”或金额异常
    for (const b of parsed.bills) {
      if (!isValidDateStr(b.date)) {
        return alert('备份中存在缺少有效日期（YYYY-MM-DD）的账单，已取消导入')
      }
      if (!Array.isArray(b.items) || b.items.some((i) => !i || typeof i.name !== 'string' || !i.name.trim() || !Number.isFinite(Number(i.qty)) || Number(i.qty) < 0 || !Number.isFinite(Number(i.price)) || Number(i.price) < 0)) {
        return alert(`备份中「${b.customerName} ${b.date}」的明细数据无效，已取消导入`)
      }
    }
    if (parsed.customers !== undefined && (!Array.isArray(parsed.customers) || parsed.customers.some((c) => !isValidBackupCustomer(c)))) {
      return alert('备份中的客户数据（含类目/输出模板结构）无效，已取消导入')
    }
    if (parsed.products !== undefined && (!Array.isArray(parsed.products) || parsed.products.some((p) => !p || typeof p !== 'object' || typeof p.name !== 'string'))) {
      return alert('备份中的类目数据无效，已取消导入')
    }
    const pendingCount = await db.bills.where('syncStatus').equals('pending').count()
    const warn = pendingCount > 0
      ? `\n⚠ 当前本机还有 ${pendingCount} 条账单未上传云端，恢复后将被备份内容替换且无法找回！`
      : ''
    if (!confirm('导入备份将覆盖当前所有客户模板和账单，确定继续吗？' + warn)) return

    const now = Date.now()
    // 规范化：补齐 month/billNo/时间戳，金额以明细重算为准，全部标记待上传防止多端分叉
    const normalizedBills = parsed.bills.map((b, i) => {
      const items = b.items.map((it) => ({
        name: it.name.trim(),
        unit: typeof it.unit === 'string' && it.unit ? it.unit : '条',
        qty: Number(it.qty),
        price: Number(it.price)
      }))
      const total = Number(items.reduce((s, it) => s + it.qty * it.price, 0).toFixed(2))
      return {
        ...b,
        items,
        billNo: typeof b.billNo === 'string' && b.billNo ? b.billNo : `NO.${b.date.replace(/-/g, '')}-R${now}-${i}`,
        month: b.date.slice(0, 7),
        status: b.status === 'verified' ? 'verified' : 'pending',
        paymentMethod: b.paymentMethod || '月结挂账',
        remark: typeof b.remark === 'string' ? b.remark : '',
        totalAmount: total,
        syncStatus: 'pending',
        createdAt: Number.isFinite(Number(b.createdAt)) ? Number(b.createdAt) : now,
        updatedAt: now
      }
    })

    await db.transaction('rw', db.customers, db.products, db.bills, db.settings, async () => {
      // bulkPut 幂等写入：备份文件内重复主键不再导致整个恢复失败
      if (Array.isArray(parsed.customers)) {
        await db.customers.clear()
        await db.customers.bulkPut(parsed.customers)
      }
      if (Array.isArray(parsed.products)) {
        await db.products.clear()
        await db.products.bulkPut(parsed.products)
      }
      await db.bills.clear()
      await db.bills.bulkPut(normalizedBills)
      if (parsed.settings && typeof parsed.settings === 'object') {
        // 保留本机管理员凭据，拒绝备份文件携带的口令/哈希覆盖（防伪造备份提权/锁死）
        const { adminPin, adminPinHash, adminPinSalt, adminPinIsDefault, key, ...safeSettings } = parsed.settings
        await saveSettings(safeSettings)
      }
    })
    await loadData()
    alert('本地数据恢复成功')
    if (navigator.onLine && cloudConfigured && currentUser.value?.isLoggedIn) {
      autoCheckAndUploadOfflineData(false)
    }
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
      :saving="billSaving"
      :customers="customers"
      :products="products"
      :editing-bill="editingBill"
      :default-customer-name="defaultBillCustomer"
      :default-date="localDateStr()"
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
      :busy="importing"
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
      @updated="loadData(); autoCheckAndUploadOfflineData(false)"
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
