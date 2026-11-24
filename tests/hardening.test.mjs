import { billTotal, allocateBillCents, hasNamedBillItems } from '../src/utils/money.js'
import { createLedgerBackup, planLedgerMerge } from '../src/db/ledgerBackup.js'
import { makeDeviceDb, credentialFields } from './device-fixture.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ExcelJS from 'exceljs'
import { webcrypto } from 'node:crypto'
import { getMonthLastDateParts } from '../src/utils/rmb.js'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
function script(path) {
  return read(path).split('<script setup>')[1].split('</script>')[0]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
}

// 模拟 IndexedDB 事务的串行化语义：同一时刻只有一个事务在执行
function mutexTx() {
  let chain = Promise.resolve()
  return (...args) => {
    const fn = args.at(-1)
    const run = chain.then(() => fn())
    chain = run.then(() => {}, () => {})
    return run
  }
}

const delay = () => new Promise(r => setTimeout(r, 2))

function makeStoreDb({ bills = [], customers = [], products = [], settings = {} } = {}) {
  const where = (table) => (index) => ({
    equals: (val) => ({
      toArray: async () => { await delay(); return table.filter(r => r[index] === val).map(r => structuredClone(r)) },
      sortBy: async (key) => { await delay(); return table.filter(r => r[index] === val).sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''))) },
      count: async () => table.filter(r => r[index] === val).length,
      first: async () => { await delay(); const f = table.find(r => r[index] === val); return f ? structuredClone(f) : undefined }
    })
  })
  const bulkPut = (table) => async (rows) => {
    for (const r of rows) {
      const row = structuredClone(r)
      if (row.id === undefined) row.id = 'auto_' + Math.random().toString(36).slice(2)
      const i = table.findIndex(x => x.id === row.id)
      if (i >= 0) table[i] = row
      else table.push(row)
    }
  }
  const db = {
    auditLogs: { toArray: async () => [], bulkPut: async () => {} },
    bills: {
      where: where(bills),
      toArray: async () => bills.map(b => structuredClone(b)),
      get: async (id) => { await delay(); const b = bills.find(x => x.id === id); return b ? structuredClone(b) : undefined },
      add: async (b) => { await delay(); bills.push(structuredClone(b)) },
      update: async (id, changes) => { const b = bills.find(x => x.id === id); if (!b) return 0; Object.assign(b, changes); return 1 },
      delete: async (id) => { const i = bills.findIndex(x => x.id === id); if (i >= 0) bills.splice(i, 1) },
      clear: async () => { bills.length = 0 },
      bulkPut: bulkPut(bills)
    },
    customers: {
      where: where(customers),
      toArray: async () => customers.map(c => structuredClone(c)),
      get: async (id) => { await delay(); const c = customers.find(x => x.id === id); return c ? structuredClone(c) : undefined },
      add: async (c) => { await delay(); customers.push(structuredClone(c)) },
      update: async (id, changes) => { const c = customers.find(x => x.id === id); if (!c) return 0; Object.assign(c, changes); return 1 },
      delete: async (id) => { const i = customers.findIndex(x => x.id === id); if (i >= 0) customers.splice(i, 1) },
      clear: async () => { customers.length = 0 },
      bulkPut: bulkPut(customers)
    },
    products: {
      toArray: async () => products.map(p => structuredClone(p)),
      clear: async () => { products.length = 0 },
      bulkPut: bulkPut(products)
    },
    settings: {
      get: async (key) => { await delay(); return settings[key] ? structuredClone(settings[key]) : undefined },
      put: async (row) => { settings[row.key] = structuredClone(row) }
    },
    transaction: mutexTx()
  }
  return { db, bills, customers, products, settings }
}

function appContext(db, extra = {}) {
  const alerts = []
  const context = vm.createContext({
    db,
    ref: v => ({ value: v }),
    watch() {}, onMounted() {}, onUnmounted() {},
    navigator: { onLine: true },
    cloudConfigured: false, billTotal, createLedgerBackup, planLedgerMerge,
    alert: m => alerts.push(String(m)),
    confirm: () => true,
    setTimeout() {},
    createDefaultExportTemplate: () => ({}),
    generateNextBillNo: async () => webcrypto.randomUUID(),
    getSettings: async () => ({}),
    saveSettings: async () => {},
    verifyAdminPin: async () => false,
    getAdminPinLockStatus: () => ({ locked: false, retryAfterMs: 0, remainingAttempts: 5 }),
    isAdminPinDefault: async () => false,
    DEFAULT_PRODUCTS: [],
    window: { prompt: () => null },
    ...extra
  })
  context.__alerts = alerts
  vm.runInContext(script('../src/App.vue'), context)
  return context
}

function spyClears(db) {
  const state = { cleared: false }
  for (const t of ['bills', 'customers', 'products']) {
    const orig = db[t].clear
    db[t].clear = async () => { state.cleared = true; return orig() }
  }
  return state
}

test('delete rechecks status inside transaction (TOCTOU admin bypass)', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', status: 'pending', updatedAt: 1 }] })
  let reads = 0
  const origGet = db.bills.get
  db.bills.get = async (id) => {
    const snap = await origGet(id)
    // 首次读取后另一窗口立刻核销：确认弹窗期间的状态变化必须被事务内二次校验拦截
    if (++reads === 1) bills[0].status = 'verified'
    return snap
  }
  const context = appContext(db, { window: { prompt: () => null } })
  await context.handleDeleteBill({ id: 'b1', status: 'pending' })
  assert.equal(bills.length, 1)
  assert.equal(bills[0].status, 'verified')
  assert(context.__alerts.some(m => m.includes('管理员')))
})

test('delete verified bill requires admin pin', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', status: 'verified', updatedAt: 1 }] })
  let pin = null
  const context = appContext(db, { verifyAdminPin: async p => p === '8888', window: { prompt: () => pin } })
  await context.handleDeleteBill({ id: 'b1', status: 'verified' })
  assert.equal(bills.length, 1)
  pin = '8888'
  await context.handleDeleteBill({ id: 'b1', status: 'verified' })
  assert.equal(bills.length, 0)
})

test('delete double click executes once', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', status: 'pending', updatedAt: 1 }] })
  const context = appContext(db)
  await Promise.all([context.handleDeleteBill({ id: 'b1' }), context.handleDeleteBill({ id: 'b1' })])
  assert.equal(bills.length, 0)
  assert(!context.__alerts.some(m => m.includes('已被删除')))
})

test('import rejects fake calendar dates but accepts leap day', async () => {
  const { db, bills, customers } = makeStoreDb()
  const context = appContext(db)
  await context.handleConfirmSmartImport([{ customerName: 'A', date: '2026-02-30', items: [{ name: 'Cloth', qty: 1, price: 1 }] }])
  assert.equal(bills.length, 0)
  assert.equal(customers.length, 0)
  assert(context.__alerts.some(m => m.includes('导入失败')))
  await context.handleConfirmSmartImport([{ customerName: 'A', date: '2024-02-29', items: [{ name: 'Cloth', qty: 2, price: 1 }] }])
  assert.equal(bills.length, 1)
  assert.equal(bills[0].month, '2024-02')
})

test('restore rejects fake calendar date before clearing any data', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'keep', customerName: 'Keep', date: '2026-11-01', items: [] }] })
  const spy = spyClears(db)
  const context = appContext(db)
  await context.handleRestoreJson(JSON.stringify({ bills: [{ customerName: 'A', date: '2026-02-30', items: [] }] }))
  assert.equal(spy.cleared, false)
  assert.equal(bills.length, 1)
  assert(context.__alerts.some(m => m.includes('有效日期')))
})

test('restore rejects malformed customer categories before clearing', async () => {
  const { db } = makeStoreDb()
  const spy = spyClears(db)
  const context = appContext(db)
  await context.handleRestoreJson(JSON.stringify({ bills: [], customers: [{ name: 'A', categories: 'oops' }] }))
  assert.equal(spy.cleared, false)
  assert(context.__alerts.some(m => m.includes('客户数据')))
})

test('restore rejects malformed export template before clearing', async () => {
  const { db } = makeStoreDb()
  const spy = spyClears(db)
  const context = appContext(db)
  await context.handleRestoreJson(JSON.stringify({ bills: [], customers: [{ name: 'A', exportTemplate: { tailColumns: 'oops' } }] }))
  assert.equal(spy.cleared, false)
  assert(context.__alerts.some(m => m.includes('客户数据')))
})

test('category index ops carry name guard against concurrent reordering', async () => {
  const { db, customers } = makeStoreDb({ customers: [{ id: 'c1', name: 'A', categories: [{ name: 'X', price: 1 }, { name: 'Y', price: 2 }] }] })
  const context = appContext(db)
  await context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'updatePrice', index: 0, name: 'Y', price: 9 })
  assert.equal(customers[0].categories[0].price, 1)
  assert(context.__alerts.some(m => m.includes('刷新')))
  await context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'updatePrice', index: 1, name: 'Y', price: 9 })
  assert.equal(customers[0].categories[1].price, 9)
  await context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'remove', index: 0, name: 'Y' })
  assert.equal(customers[0].categories.length, 2)
  await context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'remove', index: 0, name: 'X' })
  assert.equal(customers[0].categories.map(c => c.name).join(','), 'Y')
})

function excelContext() {
  const state = { output: null }
  const context = vm.createContext({
    ExcelJS, getMonthLastDateParts, allocateBillCents, hasNamedBillItems, Blob,
    URL: { createObjectURL(blob) { state.output = blob; return 'blob:test' }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) }
  })
  vm.runInContext(read('../src/utils/exportExcel.js').replace(/^import .*$/gm, '').replace(/export /g, ''), context)
  return { context, state }
}

test('detail sheet sanitizes billNo and paymentMethod formula payloads', async () => {
  const { context, state } = excelContext()
  await context.exportSettlementExcel({
    month: '2026-11',
    customer: { name: 'A', categories: [] },
    bills: [{ customerName: 'A', date: '2026-11-21', billNo: '=HYPERLINK("http://evil.example")', paymentMethod: '=cmd|\' /C calc\'!A0', items: [{ name: 'Cloth', qty: 1, price: 1 }] }],
    template: { includeDetailSheet: true, tailColumns: [] }
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await state.output.arrayBuffer())
  const row = wb.getWorksheet('每笔交易明细').getRow(2)
  assert(String(row.getCell(1).value).startsWith("'"))
  assert(String(row.getCell(9).value).startsWith("'"))
  assert.equal(row.getCell(2).value, '2026-11-21')
})

test('export without categories or padding writes a zero total, not a circular formula', async () => {
  const { context, state } = excelContext()
  await context.exportSettlementExcel({
    month: '2024-02', customer: { name: '甲' }, bills: [],
    template: { minDataRows: 0, tailColumns: [{ key: 'totalAmount', label: '总额', enabled: true }] }
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await state.output.arrayBuffer())
  assert.equal(wb.worksheets[0].getCell('AH3').value, 0)
})

test('export clamps absurd template row counts instead of freezing', async () => {
  const { context, state } = excelContext()
  await context.exportSettlementExcel({
    month: '2026-11',
    customer: { name: 'A', categories: [] },
    bills: [],
    template: { minDataRows: 1000000, trailingBlankRows: 1000000, tailColumns: [] }
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await state.output.arrayBuffer())
  assert(wb.worksheets[0].rowCount < 400)
})

test('ensureAdminCredential always writes a matching salt/hash pair', async () => {
  const { db, settings } = makeStoreDb({ settings: { profile: { key: 'profile', adminPinSalt: 'oldSalt' } } })
  const origGet = db.settings.get
  let calls = 0
  db.settings.get = async (key) => {
    // 事务内重读前，另一窗口改写了盐值：写入的盐/哈希仍必须成对一致
    if (++calls === 2) settings.profile.adminPinSalt = 'newSalt'
    return origGet(key)
  }
  const src = read('../src/db/database.js')
  const code = src.slice(src.indexOf('export async function getSettings')).replace(/^export /gm, '')
  const deviceDb = makeDeviceDb()
  const context = vm.createContext({ db, deviceDb, credentialFields, cloudConfigured: false, DEFAULT_SETTINGS: {}, DEFAULT_ADMIN_PIN: '8888', crypto: webcrypto, TextEncoder })
  vm.runInContext(code, context)
  await context.ensureAdminCredential()
  const row = await deviceDb.records.get('admin:' + db.name)
  assert.equal(row.adminPinHash, await context.hashPin('8888', row.adminPinSalt))
})

test('backup failure surfaces a Chinese error instead of silent rejection', async () => {
  const { db } = makeStoreDb()
  db.customers.toArray = async () => { throw new Error('disk full') }
  const context = appContext(db)
  await context.handleBackupJson()
  assert(context.__alerts.some(m => m.includes('导出备份失败')))
})

test('restore derives month from the validated date, ignoring bogus month', async () => {
  const { db, bills } = makeStoreDb()
  const context = appContext(db)
  await context.handleRestoreJson(JSON.stringify({
    bills: [{ customerName: 'A', date: '2026-11-21', month: '2026-13', items: [{ name: 'Cloth', qty: 1, price: 2 }] }]
  }))
  assert.equal(bills.length, 1)
  assert.equal(bills[0].month, '2026-11')
})

function makeLocalStorageMock() {
  const storage = new Map()
  return {
    storage,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    }
  }
}

// 从 getSettings 起加载 database.js 的“数据层”切片（与现有测试同一约定）
function databaseContext(db, extra = {}) {
  const src = read('../src/db/database.js')
  const code = src.slice(src.indexOf('export async function getSettings')).replace(/^export /gm, '')
  const deviceDb = makeDeviceDb()
  const context = vm.createContext({
    db, deviceDb, credentialFields, cloudConfigured: false,
    DEFAULT_SETTINGS: {},
    DEFAULT_ADMIN_PIN: '8888',
    crypto: webcrypto,
    TextEncoder,
    ...extra
  })
  vm.runInContext(code, context)
  return context
}

test('admin pin failures are rate-limited globally and persist across reloads', async () => {
  const { storage, localStorage } = makeLocalStorageMock()
  const { db, settings } = makeStoreDb()
  settings.profile = { key: 'profile', adminPinHash: 'h', adminPinSalt: 's', adminPinIsDefault: false }
  const deviceDb = makeDeviceDb()
  const mk = () => databaseContext(db, { localStorage, deviceDb })

  let ctx = mk()
  for (let i = 0; i < 5; i++) assert.equal(await ctx.verifyAdminPin('wrong'), false)
  assert.equal(ctx.getAdminPinLockStatus().locked, true)
  // 锁定期内即使口令正确也直接拒绝（不与哈希比对）
  assert.equal(await ctx.verifyAdminPin('whatever'), false)

  // “刷新页面”（全新 vm 上下文）后锁定仍生效：状态持久化在 localStorage
  ctx = mk()
  assert.equal(ctx.getAdminPinLockStatus().locked, true)
  assert(ctx.getAdminPinLockStatus().retryAfterMs > 0)

  // 锁定时长随失败轮次指数退避（第 2 轮 60s > 第 1 轮 30s）
  const first = JSON.parse(storage.get('offline_ledger_admin_pin_lock')).lockUntil - Date.now()
  ctx = mk()
  // 手动让锁过期后继续失败 5 次，进入第 2 轮锁定
  storage.set('offline_ledger_admin_pin_lock', JSON.stringify({ failures: 5, lockUntil: Date.now() - 1 }))
  ctx = mk()
  for (let i = 0; i < 5; i++) await ctx.verifyAdminPin('wrong')
  const second = JSON.parse(storage.get('offline_ledger_admin_pin_lock')).lockUntil - Date.now()
  assert(second > first)

  // 损坏的锁定记录不会造成永久锁死
  storage.set('offline_ledger_admin_pin_lock', '{oops')
  ctx = mk()
  assert.equal(ctx.getAdminPinLockStatus().locked, false)

  // 口令校验成功后清除全部失败计数
  storage.delete('offline_ledger_admin_pin_lock')
  ctx = mk()
  await ctx.changeAdminPin('654321')
  await ctx.verifyAdminPin('wrong')
  assert.equal(ctx.getAdminPinLockStatus().remainingAttempts, 4)
  assert.equal(await ctx.verifyAdminPin('654321'), true)
  assert.equal(ctx.getAdminPinLockStatus().remainingAttempts, 5)
})

test('admin pin default flag is set on seed and cleared after change', async () => {
  const { db, settings } = makeStoreDb({ settings: { profile: { key: 'profile', companyName: 'X' } } })
  const ctx = databaseContext(db)
  await ctx.ensureAdminCredential()
  assert.equal(await ctx.isAdminPinDefault(), true)
  await ctx.changeAdminPin('654321')
  assert.equal(await ctx.isAdminPinDefault(), false)
  assert.equal(settings.profile.adminPin, undefined)
  // 改回出厂默认口令会被重新标记，强制管理员再次修改
  await ctx.changeAdminPin('8888')
  assert.equal(await ctx.isAdminPinDefault(), true)
})

test('cloud url is restricted to official dexie.cloud hosts', () => {
  const { localStorage } = makeLocalStorageMock()
  const src = read('../src/db/database.js')
  const code = src
    .slice(src.indexOf('const STORAGE_URL_KEY'))
    .split('export const db')[0]
    .replace(/^export /gm, '')
  const ctx = vm.createContext({ DEFAULT_CLOUD_URL: '', localStorage })
  vm.runInContext(code, ctx)

  assert.equal(ctx.setSavedCloudUrl('http://evil.example.com'), false)
  assert.equal(ctx.setSavedCloudUrl('https://evil.example.com/imposter'), false)
  assert.equal(ctx.setSavedCloudUrl('https://sub.dexie.cloud.evil.com'), false)
  assert.equal(ctx.setSavedCloudUrl('https://abc123.dexie.cloud/'), true)
  assert.equal(ctx.getActiveCloudUrl(), 'https://abc123.dexie.cloud')

  // localStorage 被篡改为任意第三方地址时，getActiveCloudUrl 视为未配置
  localStorage.setItem('offline_ledger_dexie_cloud_url', 'https://attacker.example.com')
  assert.equal(ctx.getActiveCloudUrl(), '')
})
