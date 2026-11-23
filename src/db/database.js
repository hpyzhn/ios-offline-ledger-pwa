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
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_URL_KEY) : ''
  const url = (saved || DEFAULT_CLOUD_URL || '').trim()
  // 历史 localStorage 残留或被篡改的非官方地址一律视为未配置，不参与云同步
  return isValidCloudUrl(url) ? url : ''
}

export function setSavedCloudUrl(url) {
  if (typeof localStorage === 'undefined') return false
  const clean = (url || '').trim().replace(/\/+$/, '')
  if (clean && !isValidCloudUrl(clean)) return false
  if (clean) localStorage.setItem(STORAGE_URL_KEY, clean)
  else localStorage.removeItem(STORAGE_URL_KEY)
  return true
}

export const db = new Dexie('OfflineLedgerCloudDB', { addons: [dexieCloud] })

// v2: bills 增加 syncStatus / updatedAt；新增 auditLogs（管理员改单审计日志）
db.version(2).stores({
  products: '@id, name, unit, defaultPrice, createdAt',
  customers: '@id, name, createdAt',
  bills: '@id, billNo, date, month, customerName, status, syncStatus, paymentMethod, totalAmount, createdAt, updatedAt',
  auditLogs: '@id, billId, billNo, customerName, createdAt',
  settings: 'key'
})

export const cloudConfigured = Boolean(getActiveCloudUrl())

if (cloudConfigured) {
  db.cloud.configure({
    databaseUrl: getActiveCloudUrl(),
    requireAuth: false, // 仅首次手动登录，之后自动沿用本地持久化 Token，不主动弹窗
    tryUseServiceWorker: false
  })
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

export const DEFAULT_SETTINGS = {
  companyName: '广州市羽洁洗涤厂结算表',
  handlerName: '经手人'
}

// 管理员默认口令（仅用于首次迁移；之后以加盐哈希形式保存在本地/云库，不再明文可读）
export const DEFAULT_ADMIN_PIN = '8888'

export async function seedInitialData() {
  const now = Date.now()
  // 使用固定主键 + bulkPut，保证多标签页并发首启时也不会重复写入
  await db.transaction('rw', db.products, db.customers, db.settings, async () => {
    if ((await db.products.count()) === 0) {
      await db.products.bulkPut(
        DEFAULT_PRODUCTS.map((p, i) => ({ ...p, id: 'seed_product_' + i, createdAt: now }))
      )
    }

    if ((await db.settings.get('profile')) === undefined) {
      await db.settings.put({ key: 'profile', ...DEFAULT_SETTINGS })
    }

    if ((await db.customers.count()) === 0) {
      await db.customers.bulkPut([
        {
          id: 'seed_customer_1',
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
          id: 'seed_customer_2',
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
  const row = await db.settings.get('profile')
  return row ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS }
}

export async function saveSettings(data) {
  // 事务内读-改-写：避免与改口令/恢复备份等并发写入互相整行覆盖、丢失字段
  await db.transaction('rw', db.settings, async () => {
    const row = await db.settings.get('profile')
    const current = row ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS }
    await db.settings.put({ key: 'profile', ...current, ...data })
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

export async function verifyAdminPin(pin) {
  // 全局统一限速：锁定期内直接拒绝，后台登录与口令弹窗两条入口共用同一份状态
  const lockState = loadPinLockState()
  if (lockState.lockUntil > Date.now()) return false
  const row = await db.settings.get('profile')
  if (row?.adminPinHash && row?.adminPinSalt) {
    const hash = await hashPin(String(pin), row.adminPinSalt)
    if (hash === row.adminPinHash) {
      clearPinLockState()
      return true
    }
    recordPinFailure(lockState)
    return false
  }
  // 兼容旧版本：历史明文口令可直接比对，通过后自动迁移为哈希存储
  const legacy = row?.adminPin !== undefined && String(row?.adminPin) !== ''
    ? String(row.adminPin)
    : DEFAULT_ADMIN_PIN
  if (String(pin) !== legacy) {
    recordPinFailure(lockState)
    return false
  }
  await ensureAdminCredential()
  clearPinLockState()
  return true
}

export async function changeAdminPin(newPin) {
  const row = (await db.settings.get('profile')) || {}
  const salt = row.adminPinSalt || newSalt()
  // 哈希计算（WebCrypto 异步）放在事务外，避免事务因等待非 IDB 异步而提前提交
  const adminPinHash = await hashPin(String(newPin), salt)
  await db.transaction('rw', db.settings, async () => {
    // 事务内重新读取最新行，只覆盖凭据字段，保留并发写入的其他设置
    const fresh = (await db.settings.get('profile')) || {}
    const clean = {
      ...fresh,
      adminPinSalt: salt,
      adminPinHash,
      // 改回出厂默认口令时重新标记，强制管理员再次修改（默认口令已随开源代码公开）
      adminPinIsDefault: String(newPin) === DEFAULT_ADMIN_PIN
    }
    delete clean.adminPin
    await db.settings.put({ key: 'profile', ...clean })
  })
}

export async function ensureAdminCredential() {
  const row = (await db.settings.get('profile')) || {}
  // 推断当前口令是否仍为出厂默认（含历史版本已哈希迁移但从未改过的存量安装）
  let isDefault = row.adminPinIsDefault === true
  if (row.adminPinIsDefault === undefined) {
    if (row.adminPinHash && row.adminPinSalt) {
      isDefault = (await hashPin(DEFAULT_ADMIN_PIN, row.adminPinSalt)) === row.adminPinHash
    } else {
      const legacy = row?.adminPin !== undefined && String(row?.adminPin) !== ''
        ? String(row.adminPin)
        : DEFAULT_ADMIN_PIN
      isDefault = legacy === DEFAULT_ADMIN_PIN
    }
  }
  // 已是安全的哈希形态、无遗留明文且默认口令标记无变化时，无需每次启动都回写
  // （减少并发覆盖窗口与同步抖动）
  if (row.adminPinHash && row.adminPinIsDefault === isDefault && row.adminPin === undefined) return
  const salt = row.adminPinSalt || newSalt()
  let adminPinHash = row.adminPinHash
  if (!adminPinHash) {
    const legacy = row?.adminPin !== undefined && String(row?.adminPin) !== ''
      ? String(row.adminPin)
      : DEFAULT_ADMIN_PIN
    adminPinHash = await hashPin(legacy, salt)
  }
  await db.transaction('rw', db.settings, async () => {
    // 事务内重读最新行：若其他窗口刚写入了凭据/设置，以最新值为准，避免旧快照整行覆盖
    const fresh = (await db.settings.get('profile')) || {}
    const clean = { ...fresh }
    // 盐与哈希必须成对写入：已有哈希则原样保留，否则写入本次计算的配对值，
    // 避免“新盐 + 旧哈希”错配导致管理员口令永久无法验证
    if (!fresh.adminPinHash) {
      clean.adminPinSalt = salt
      clean.adminPinHash = adminPinHash
    }
    clean.adminPinIsDefault = isDefault
    delete clean.adminPin
    await db.settings.put({ key: 'profile', ...clean })
  })
}

/**
 * 当前管理员口令是否仍为出厂默认（8888）。
 * 默认口令已随开源代码公开，UI 层应据此强制管理员先修改口令再放行敏感操作。
 */
export async function isAdminPinDefault() {
  const row = await db.settings.get('profile')
  return row?.adminPinIsDefault === true
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
