import Dexie from 'dexie'
import dexieCloud from 'dexie-cloud-addon'

/**
 * 填入 npx dexie-cloud create 生成的免费云数据库地址，例如：
 * export const DEFAULT_CLOUD_URL = 'https://z12345678.dexie.cloud'
 */
export const DEFAULT_CLOUD_URL = import.meta.env.VITE_DEXIE_CLOUD_URL || 'https://zsw06q660.dexie.cloud'

const STORAGE_URL_KEY = 'offline_ledger_dexie_cloud_url'

export function getActiveCloudUrl() {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_URL_KEY) : ''
  return (saved || DEFAULT_CLOUD_URL || '').trim()
}

export function setSavedCloudUrl(url) {
  if (typeof localStorage === 'undefined') return
  const clean = (url || '').trim().replace(/\/+$/, '')
  if (clean) localStorage.setItem(STORAGE_URL_KEY, clean)
  else localStorage.removeItem(STORAGE_URL_KEY)
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
  handlerName: '经手人',
  adminPin: '8888' // 管理员后台默认口令，可在后台修改
}

export async function seedInitialData() {
  const now = Date.now()
  if ((await db.products.count()) === 0) {
    await db.products.bulkAdd(DEFAULT_PRODUCTS.map((p) => ({ ...p, createdAt: now })))
  }

  if ((await db.settings.get('profile')) === undefined) {
    await db.settings.put({ key: 'profile', ...DEFAULT_SETTINGS })
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
}

export async function getSettings() {
  const row = await db.settings.get('profile')
  return row ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS }
}

export async function saveSettings(data) {
  const current = await getSettings()
  await db.settings.put({ key: 'profile', ...current, ...data })
}

export async function generateNextBillNo(dateStr) {
  const prefix = 'NO.' + dateStr.replace(/-/g, '')
  const sameDay = await db.bills.where('date').equals(dateStr).count()
  return `${prefix}${String(sameDay + 1).padStart(3, '0')}`
}
