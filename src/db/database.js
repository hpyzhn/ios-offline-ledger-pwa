import Dexie from 'dexie'
import dexieCloud from 'dexie-cloud-addon'

/**
 * 云数据库地址不再写死在源码（避免个人云库 URL 随代码/仓库泄露）。
 * 可通过两种方式配置：
 *   1. 构建时注入环境变量 VITE_DEXIE_CLOUD_URL；
 *   2. 在应用「客户设置 → 云端账号同步」中手动填写并保存（写入 localStorage）。
 */
export const DEFAULT_CLOUD_URL = import.meta.env.VITE_DEXIE_CLOUD_URL || ''

const STORAGE_URL_KEY = 'offline_ledger_dexie_cloud_url'

// 仅允许 Dexie Cloud 官方域名（https://xxx.dexie.cloud），
// 防止同步数据被重定向到任意第三方服务器造成客户账单泄露
const CLOUD_URL_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.dexie\.cloud$/i

export function isValidCloudUrl(url) {
  return CLOUD_URL_PATTERN.test(String(url || '').trim())
}

export function getActiveCloudUrl() {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_URL_KEY) : null
  const url = (saved ?? DEFAULT_CLOUD_URL).trim()
  // 历史 localStorage 残留或被篡改的非官方地址一律视为未配置，不参与云同步
  return isValidCloudUrl(url) ? url : ''
}

export function setSavedCloudUrl(url) {
  if (typeof localStorage === 'undefined') return false
  const clean = (url || '').trim().replace(/\/+$/, '')
  if (clean && !isValidCloudUrl(clean)) return false
  localStorage.setItem(STORAGE_URL_KEY, clean.toLowerCase())
  return true
}

export const db = new Dexie('OfflineLedgerCloudDB', { addons: [dexieCloud] })
export const deviceDb = new Dexie('OfflineLedgerDeviceDB')
deviceDb.version(1).stores({ records: 'key' })

const credentialFields = ['adminPin', 'adminPinHash', 'adminPinSalt', 'adminPinIsDefault']

// v2: bills 增加 syncStatus / updatedAt；新增 auditLogs（管理员改单审计日志）
db.version(2).stores({
  products: '@id, name, unit, defaultPrice, createdAt',
  customers: '@id, name, createdAt',
  bills: '@id, billNo, date, month, customerName, status, syncStatus, paymentMethod, totalAmount, createdAt, updatedAt',
  auditLogs: '@id, billId, billNo, customerName, createdAt',
  settings: 'key'
})

export const localLedgerOnly = new URLSearchParams(location.search).get('ledger') === 'local'
export const cloudConfigured = !localLedgerOnly && Boolean(getActiveCloudUrl())

if (cloudConfigured) {
  db.cloud.configure({
    databaseUrl: getActiveCloudUrl(),
    requireAuth: false, // 仅首次手动登录，之后自动沿用本地持久化 Token，不主动弹窗
    tryUseServiceWorker: false,
    unsyncedProperties: { settings: credentialFields }
  })
}

export function pendingTransferKey() {
  return `transfer:${cloudConfigured ? getActiveCloudUrl().toLowerCase() : 'local'}`
}

export function cloudNeedsVerification(user, error = '') {
  if (!user?.isLoggedIn) return false
  const expired = value => value && new Date(value).getTime() <= Date.now()
  return /refresh token|401|unauthorized|invalid_grant/i.test(String(error?.message || error)) ||
    Boolean(expired(user.accessTokenExpiration) && (!user.refreshToken || expired(user.refreshTokenExpiration)))
}

let reopeningCloud
export async function syncCloudLedger() {
  if (!db.cloud.currentUser.value?.isLoggedIn) throw new Error('请先登录云账本')
  if (reopeningCloud) await reopeningCloud
  const state = await db.table('$syncState').get('syncState')
  const user = db.cloud.currentUser.value
  if (!state?.realms?.includes(user.userId) && /error|offline/.test(db.cloud.syncState.value?.phase)) {
    // 首次账号同步失败时 SDK 未启动后台同步。重新打开同一数据库来重试。
    reopeningCloud ||= (async () => {
      db.close()
      await db.open()
    })().finally(() => { reopeningCloud = undefined })
    await reopeningCloud
    const retried = await db.table('$syncState').get('syncState')
    if (!retried?.realms?.includes(user.userId)) {
      throw new Error(db.cloud.syncState.value.error?.message || '账号首次同步未完成，请重试')
    }
    return
  }
  let timer
  try {
    await Promise.race([
      db.cloud.sync({ purpose: 'pull', wait: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('同步超时，请检查网络后重试')), 20000) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const DEFAULT_PRODUCTS = [
  { name: '台布', unit: '条', defaultPrice: 1.0 },
  { name: '大台布', unit: '条', defaultPrice: 1.8 },
  { name: '椅套', unit: '个', defaultPrice: 0.8 },
  { name: '台裙', unit: '条', defaultPrice: 4.5 },
  { name: '席巾', unit: '条', defaultPrice: 0.2 },
  { name: '窗帘', unit: '幅', defaultPrice: 4.5 },
  { name: '红台布', unit: '条', defaultPrice: 1.0 },
  { name: '旧台布', unit: '条', defaultPrice: 1.0 }
]

export function createDefaultExportTemplate(sheetTitle = '广州市羽洁洗涤厂结算表') {
  return {
    sheetTitle,
    showDate: true,
    includeZeroRows: true,
    minDataRows: 14,
    trailingBlankRows: 3,
    statusFilter: 'all',
    includeTotalRow: true,
    showTotalLabel: false,
    includeDetailSheet: false,
    tailColumns: [
      { key: 'totalQty', label: '总数', enabled: true, builtIn: true },
      { key: 'unitPrice', label: '单价', enabled: true, builtIn: true },
      { key: 'totalAmount', label: '总额', enabled: true, builtIn: true },
      { key: 'unit', label: '单位', enabled: false, builtIn: true },
      { key: 'verifyStatus', label: '核销状态', enabled: false, builtIn: true },
      { key: 'remark', label: '备注', enabled: false, builtIn: true }
    ],
    extraStatusFields: []
  }
}

// 旧模板可能只保存了修改过的字段。只对展示格式补默认值，不改写客户档案。
export function readExportTemplate(customer, defaultTitle) {
  const defaults = createDefaultExportTemplate(typeof defaultTitle === 'string' && defaultTitle.trim() ? defaultTitle : undefined)
  const saved = customer?.exportTemplate
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults
  return {
    ...defaults,
    ...saved,
    sheetTitle: typeof saved.sheetTitle === 'string' && saved.sheetTitle.trim() ? saved.sheetTitle : defaults.sheetTitle,
    tailColumns: Array.isArray(saved.tailColumns)
      ? saved.tailColumns
        .filter(col => typeof col?.key === 'string' && col.key)
        .map(col => ({ ...defaults.tailColumns.find(base => base.key === col.key), ...col }))
        .filter(col => typeof col.label === 'string')
      : defaults.tailColumns,
    extraStatusFields: Array.isArray(saved.extraStatusFields)
      ? saved.extraStatusFields.filter(field => typeof field?.label === 'string')
      : []
  }
}

export const DEFAULT_SETTINGS = {
  companyName: '广州市羽洁洗涤厂结算表',
  handlerName: '经手人'
}

// 管理员默认口令仅用于本机首次配置。
export const DEFAULT_ADMIN_PIN = '8888'

export async function seedInitialData() {
  const now = Date.now()
  // 在同一读写事务内判空并写入，避免多标签页重复初始化。@id 由 Dexie Cloud 生成。
  if (!cloudConfigured) await db.transaction('rw', db.products, db.customers, async () => {
    if ((await db.products.count()) === 0) {
      await db.products.bulkAdd(
        DEFAULT_PRODUCTS.map((p) => ({ ...p, createdAt: now }))
      )
    }

    if ((await db.customers.count()) === 0) {
      await db.customers.bulkAdd([
        {
          name: '留香东江酒店',
          categories: DEFAULT_PRODUCTS.map((p) => ({
            name: p.name,
            unit: p.unit,
            price: p.defaultPrice,
            enabled: true
          })),
          exportTemplate: createDefaultExportTemplate(DEFAULT_SETTINGS.companyName),
          createdAt: now
        },
        {
          name: '餐厅A',
          categories: [
            { name: '台布', unit: '条', price: 1.0, enabled: true },
            { name: '椅套', unit: '个', price: 0.8, enabled: true }
          ],
          exportTemplate: createDefaultExportTemplate(DEFAULT_SETTINGS.companyName),
          createdAt: now + 1
        }
      ])
    }
  })

  // 首次/每次启动确保管理员口令已迁移为加盐哈希存储
  await ensureAdminCredential()
}

export async function getSettings() {
  const row = (cloudConfigured && await db.settings.get('#profile')) || await db.settings.get('profile')
  return {
    companyName: row?.companyName ?? DEFAULT_SETTINGS.companyName,
    handlerName: row?.handlerName ?? DEFAULT_SETTINGS.handlerName
  }
}

export async function saveSettings(data) {
  // 事务内读-改-写：避免与改口令/恢复备份等并发写入互相整行覆盖、丢失字段
  await db.transaction('rw', db.settings, async () => {
    const key = cloudConfigured ? '#profile' : 'profile'
    const current = await getSettings()
    const next = { ...current }
    for (const key of ['companyName', 'handlerName']) {
      if (typeof data[key] === 'string') next[key] = data[key]
    }
    await db.settings.put({ ...next, key })
  })
}

// ==================== 管理员口令防暴力破解（全局统一限速） ====================
// 所有校验入口（管理员后台登录、删除/撤回已核销单据的口令弹窗）共用同一份失败
// 计数与锁定状态，并持久化到 localStorage：刷新页面、重开弹窗均无法重置计数。
const PIN_LOCK_STORAGE_KEY = 'offline_ledger_admin_pin_lock'
const PIN_MAX_FAILURES = 5
const PIN_LOCK_BASE_MS = 30 * 1000
const PIN_LOCK_MAX_MS = 15 * 60 * 1000

// 无 localStorage 环境（如 Node 测试沙箱）下的内存兜底
let pinLockMemory = null

function loadPinLockState() {
  let state = pinLockMemory
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(PIN_LOCK_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && Number.isFinite(parsed.failures) && Number.isFinite(parsed.lockUntil)) {
          state = { failures: Number(parsed.failures), lockUntil: Number(parsed.lockUntil) }
        }
      }
    } catch {
      // 记录损坏时当作无记录处理，避免永久锁死
    }
  }
  if (!state) state = { failures: 0, lockUntil: 0 }
  return state
}

function savePinLockState(state) {
  pinLockMemory = state
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PIN_LOCK_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 被禁用/写满时退化为仅内存限速
  }
}

function clearPinLockState() {
  pinLockMemory = { failures: 0, lockUntil: 0 }
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(PIN_LOCK_STORAGE_KEY)
  } catch {
    // 忽略清理失败
  }
}

// 指数退避：每累计 5 次失败锁定一次，锁时长依次 30s/60s/120s…，封顶 15 分钟
function pinLockDurationMs(failures) {
  const lockRounds = Math.max(1, Math.floor(failures / PIN_MAX_FAILURES))
  return Math.min(PIN_LOCK_BASE_MS * Math.pow(2, lockRounds - 1), PIN_LOCK_MAX_MS)
}

function recordPinFailure(state) {
  const failures = state.failures + 1
  if (failures % PIN_MAX_FAILURES === 0) {
    savePinLockState({ failures, lockUntil: Date.now() + pinLockDurationMs(failures) })
  } else {
    savePinLockState({ failures, lockUntil: 0 })
  }
}

export function getAdminPinLockStatus() {
  const state = loadPinLockState()
  const now = Date.now()
  if (state.lockUntil > now) {
    return { locked: true, retryAfterMs: state.lockUntil - now, remainingAttempts: 0 }
  }
  const inCycle = state.failures % PIN_MAX_FAILURES
  return { locked: false, retryAfterMs: 0, remainingAttempts: PIN_MAX_FAILURES - inCycle }
}

function fallbackHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i)
    h = h >>> 0
  }
  return 'djb2_' + h.toString(16).padStart(8, '0')
}

async function sha256Hex(str) {
  if (globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function') {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // 非安全上下文（无法使用 WebCrypto）时降级为非加密哈希，至少避免明文落库
  return fallbackHash(str)
}

function newSalt() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export async function hashPin(pin, salt) {
  return sha256Hex(`${salt}::${String(pin)}`)
}

function adminCredentialKey() {
  return 'admin:' + db.name
}

export async function verifyAdminPin(pin) {
  const lockState = loadPinLockState()
  if (lockState.lockUntil > Date.now()) return false
  await ensureAdminCredential()
  const row = await deviceDb.records.get(adminCredentialKey())
  const valid = row
    ? (await hashPin(pin, row.adminPinSalt)) === row.adminPinHash
    : String(pin) === DEFAULT_ADMIN_PIN
  if (valid) clearPinLockState()
  else recordPinFailure(lockState)
  return valid
}

export async function changeAdminPin(newPin) {
  const adminPinSalt = newSalt()
  const adminPinHash = await hashPin(newPin, adminPinSalt)
  await deviceDb.records.put({
    key: adminCredentialKey(),
    adminPinSalt,
    adminPinHash,
    adminPinIsDefault: String(newPin) === DEFAULT_ADMIN_PIN
  })
}

export async function ensureAdminCredential() {
  const row = await db.settings.get('profile')
  if (!row || !credentialFields.some(field => row[field] !== undefined)) return
  const key = adminCredentialKey()
  const legacyPin = String(row.adminPin ?? DEFAULT_ADMIN_PIN) || DEFAULT_ADMIN_PIN
  const salt = row.adminPinSalt || newSalt()
  const hash = row.adminPinHash && row.adminPinSalt ? row.adminPinHash : await hashPin(legacyPin, salt)
  const isDefault = row.adminPinIsDefault ?? (hash === await hashPin(DEFAULT_ADMIN_PIN, salt))
  // 先落盘到设备库，再清理旧副本。并发迁移不得覆盖新设置的口令。
  await deviceDb.transaction('rw', deviceDb.records, async () => {
    if (await deviceDb.records.get(key)) return
    await deviceDb.records.put({ key, adminPinSalt: salt, adminPinHash: hash, adminPinIsDefault: isDefault })
  })
  await db.transaction('rw', db.settings, async () => {
    const latest = await db.settings.get('profile')
    if (!latest || !credentialFields.some(field => latest[field] !== undefined)) return
    for (const field of credentialFields) delete latest[field]
    await db.settings.put(latest)
  })
}

export async function isAdminPinDefault() {
  const row = await deviceDb.records.get(adminCredentialKey())
  return row?.adminPinIsDefault !== false
}

export async function generateNextBillNo(dateStr) {
  const prefix = 'NO.' + String(dateStr || '').replace(/-/g, '')
  // 非安全上下文（如 http 局域网访问）下 crypto.randomUUID 不可用，
  // 降级为 Math.random 版 UUID，避免整笔交易因 TypeError 失败
  const uuid =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
        })
  return `${prefix}-${uuid}`
}
