import { billTotal } from '../src/utils/money.js'
import { createLedgerBackup, planLedgerMerge } from '../src/db/ledgerBackup.js'
import { makeDeviceDb, credentialFields } from './device-fixture.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'

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

test('double submit creates only one bill', async () => {
  const { db, bills } = makeStoreDb()
  const context = appContext(db)
  const payload = { customerName: 'A', date: '2026-11-21', month: '2099-01', items: [{ name: 'Cloth', qty: 10, price: 1 }], totalAmount: 10 }
  await Promise.all([context.handleSaveBill(payload), context.handleSaveBill(payload)])
  assert.equal(bills.length, 1)
  assert.equal(bills[0].syncStatus, 'pending')
  assert.equal(vm.runInContext('billSaving.value', context), false)
})

test('edit with stale baseUpdatedAt is rejected instead of overwriting', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', updatedAt: 200, totalAmount: 10, month: '2026-11' }] })
  const context = appContext(db)
  vm.runInContext('showBillModal.value = true', context)
  await context.handleSaveBill({ id: 'b1', baseUpdatedAt: 100, month: '2026-11', totalAmount: 99, items: [], customerName: 'A', date: '2026-11-21' })
  assert.equal(bills[0].totalAmount, 10)
  assert.equal(bills[0].updatedAt, 200)
  assert(context.__alerts.some(m => m.includes('已被其他窗口或设备修改')))
  assert.equal(vm.runInContext('showBillModal.value', context), false)
})

test('edit on deleted bill fails loudly without writing', async () => {
  const { db, bills } = makeStoreDb()
  const context = appContext(db)
  await context.handleSaveBill({ id: 'gone', baseUpdatedAt: 1, month: '2026-11', totalAmount: 5, items: [], customerName: 'A', date: '2026-11-21' })
  assert.equal(bills.length, 0)
  assert(context.__alerts.some(m => m.includes('不存在或已被')))
})

test('edit with matching baseUpdatedAt saves and strips the baseline field', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', updatedAt: 200, totalAmount: 10, month: '2026-11' }] })
  const context = appContext(db)
  await context.handleSaveBill({ id: 'b1', baseUpdatedAt: 200, month: '2026-11', totalAmount: 30, items: [{ name: 'Cloth', qty: 10, price: 3 }], customerName: 'A', date: '2026-11-21' })
  assert.equal(bills[0].totalAmount, 30)
  assert.equal(bills[0].syncStatus, 'pending')
  assert(bills[0].updatedAt > 200)
  assert(!('baseUpdatedAt' in bills[0]))
})

test('toggle verify uses fresh DB status and requires admin for verified bills', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'b1', status: 'verified', updatedAt: 1 }] })
  let pin = null
  const context = appContext(db, {
    verifyAdminPin: async (p) => p === '8888',
    window: { prompt: () => pin }
  })
  // UI 快照显示未核销，但库内已核销：取消口令则不得改动
  await context.handleToggleVerify({ id: 'b1', status: 'pending' })
  assert.equal(bills[0].status, 'verified')
  // 输入正确口令后才允许撤回
  pin = '8888'
  await context.handleToggleVerify({ id: 'b1', status: 'pending' })
  assert.equal(bills[0].status, 'pending')
  assert.equal(bills[0].syncStatus, 'pending')
})

test('concurrent addCustomer with same name creates only one record', async () => {
  const { db, customers } = makeStoreDb()
  const context = appContext(db)
  await Promise.all([context.handleAddCustomer('A'), context.handleAddCustomer('A')])
  assert.equal(customers.length, 1)
  assert(context.__alerts.some(m => m.includes('已存在同名客户')))
})

test('concurrent category add operations do not lose updates', async () => {
  const { db, customers } = makeStoreDb({ customers: [{ id: 'c1', name: 'A', categories: [] }] })
  const context = appContext(db)
  await Promise.all([
    context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'add', category: { name: 'X', unit: '条', price: 1, enabled: true } }),
    context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'add', category: { name: 'Y', unit: '条', price: 2, enabled: true } })
  ])
  assert.equal(customers[0].categories.map(c => c.name).sort().join(','), 'X,Y')
})

test('category price op rejects negative price and keeps data', async () => {
  const { db, customers } = makeStoreDb({ customers: [{ id: 'c1', name: 'A', categories: [{ name: 'X', price: 1 }] }] })
  const context = appContext(db)
  await context.handleUpdateCustomerCategories({ customerId: 'c1', op: 'updatePrice', index: 0, price: -5 })
  assert.equal(customers[0].categories[0].price, 1)
  assert(context.__alerts.some(m => m.includes('非负数')))
})

test('concurrent settings save and pin change keep both fields', async () => {
  const { db, settings } = makeStoreDb({ settings: { profile: { key: 'profile', companyName: 'Old' } } })
  const src = read('../src/db/database.js')
  const code = src.slice(src.indexOf('export async function getSettings')).replace(/^export /gm, '')
  const deviceDb = makeDeviceDb()
  const context = vm.createContext({
    db, deviceDb, credentialFields, cloudConfigured: false,
    DEFAULT_SETTINGS: { companyName: 'Default', handlerName: '经手人' },
    DEFAULT_ADMIN_PIN: '8888',
    crypto: webcrypto,
    TextEncoder
  })
  vm.runInContext(code, context)
  await Promise.all([
    context.saveSettings({ companyName: 'NewCo' }),
    context.changeAdminPin('123456')
  ])
  const row = settings.profile
  assert.equal(row.companyName, 'NewCo')
  const credential = await deviceDb.records.get('admin:' + db.name)
  assert.equal(credential.adminPinHash, await context.hashPin('123456', credential.adminPinSalt))
  assert.equal(row.adminPinHash, undefined)
  assert.equal(row.adminPin, undefined)
})

test('ensureAdminCredential does not rewrite an already migrated row', async () => {
  const { db, settings } = makeStoreDb({ settings: { profile: { key: 'profile', adminPinHash: 'h', adminPinSalt: 's', adminPinIsDefault: false } } })
  let puts = 0
  const origPut = db.settings.put
  db.settings.put = async (row) => { puts++; return origPut(row) }
  const src = read('../src/db/database.js')
  const code = src.slice(src.indexOf('export async function getSettings')).replace(/^export /gm, '')
  const deviceDb = makeDeviceDb()
  const context = vm.createContext({ db, deviceDb, credentialFields, cloudConfigured: false, DEFAULT_SETTINGS: {}, DEFAULT_ADMIN_PIN: '8888', crypto: webcrypto, TextEncoder })
  vm.runInContext(code, context)
  await context.ensureAdminCredential()
  await context.ensureAdminCredential()
  assert.equal(puts, 1)
  assert.equal(settings.profile.adminPinHash, undefined)
  assert.equal((await deviceDb.records.get('admin:' + db.name)).adminPinHash, 'h')
})

test('bill number generation works without crypto.randomUUID (non-secure context)', async () => {
  const src = read('../src/db/database.js')
  const code = src.slice(src.indexOf('export async function generateNextBillNo')).replace('export ', '')
  const context = vm.createContext({})
  vm.runInContext(code, context)
  const ids = await Promise.all(Array.from({ length: 200 }, () => context.generateNextBillNo('2026-11-21')))
  assert.equal(new Set(ids).size, 200)
  assert(ids.every(id => id.startsWith('NO.20261121-')))
  const noDate = await context.generateNextBillNo(undefined)
  assert(noDate.startsWith('NO.-'))
})

test('restore normalizes bills, recomputes totals and preserves local credentials', async () => {
  const { db, bills, settings } = makeStoreDb({
    bills: [{ id: 'old', syncStatus: 'synced', customerName: 'Old', date: '2026-10-01', month: '2026-10', items: [] }],
    settings: { profile: { key: 'profile', companyName: 'Old', adminPinHash: 'curHash', adminPinSalt: 'curSalt' } }
  })
  const context = appContext(db, {
    saveSettings: async (data) => { Object.assign(settings.profile, data) }
  })
  const backup = {
    bills: [{ customerName: 'A', date: '2026-11-21', totalAmount: 999, items: [{ name: 'Cloth', qty: 2, price: 3 }] }],
    customers: [{ name: 'A' }],
    settings: { companyName: 'New', adminPinHash: 'evilHash', adminPinSalt: 'evilSalt', adminPin: '0000' }
  }
  await context.handleRestoreJson(JSON.stringify(backup))
  await context.handleRestoreJson(JSON.stringify(backup))
  assert.equal(bills.length, 2)
  assert.equal(bills[0].id, 'old')
  assert.equal(bills[1].month, '2026-11')
  assert.equal(bills[1].syncStatus, 'pending')
  assert.equal(bills[1].totalAmount, 6)
  assert(typeof bills[1].billNo === 'string' && bills[1].billNo.length > 0)
  assert(Number.isFinite(bills[1].updatedAt))
  assert.equal(settings.profile.companyName, 'Old')
  assert.equal(settings.profile.adminPinHash, 'curHash')
  assert.equal(settings.profile.adminPinSalt, 'curSalt')
  assert.equal(settings.profile.adminPin, undefined)
})

test('restore rejects invalid backup before clearing any data', async () => {
  const { db, bills } = makeStoreDb({ bills: [{ id: 'keep', customerName: 'Keep', date: '2026-11-01', items: [] }] })
  let cleared = false
  const origClear = db.bills.clear
  db.bills.clear = async () => { cleared = true; return origClear() }
  const context = appContext(db)
  await context.handleRestoreJson(JSON.stringify({ bills: [{ customerName: 'A', date: 'not-a-date', items: [] }] }))
  assert.equal(cleared, false)
  assert.equal(bills.length, 1)
  assert(context.__alerts.some(m => m.includes('有效日期')))
})

function adminContext(db) {
  return vm.createContext({
    db, billTotal, ref: v => ({ value: v }), computed: fn => ({ get value() { return fn() } }),
    watch() {}, defineProps: () => ({}), defineEmits: () => () => {}, alert() {}
  })
}

test('admin fix on concurrently modified bill is rejected', async () => {
  let bill = { id: 'old', totalAmount: 10, items: [], updatedAt: 200 }
  let auditAdds = 0
  const db = {
    bills: { get: async () => structuredClone(bill), update: async (_, change) => Object.assign(bill, change), orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) },
    auditLogs: { add: async () => { auditAdds++ }, orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    transaction: async (...args) => { const before = structuredClone(bill); try { await args.at(-1)() } catch (e) { bill = before; throw e } }
  }
  const context = adminContext(db)
  vm.runInContext(script('../src/components/AdminPanelModal.vue'), context)
  vm.runInContext(`editingOrder.value = {id:'old',totalAmount:10,items:[],updatedAt:100}; editItems.value = [{name:'Cloth',qty:10,price:2}]; editReason.value = 'correction'`, context)
  await assert.rejects(context.saveOrderFix(), /已被其他窗口或设备修改/)
  assert.equal(bill.totalAmount, 10)
  assert.equal(auditAdds, 0)
})

test('admin fix double submit writes only one audit log', async () => {
  let bill = { id: 'old', totalAmount: 10, items: [] }
  const logs = []
  const db = {
    bills: { get: async () => structuredClone(bill), update: async (_, change) => Object.assign(bill, change), orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) },
    auditLogs: { add: async (l) => { await delay(); logs.push(l) }, orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    transaction: mutexTx()
  }
  const context = adminContext(db)
  vm.runInContext(script('../src/components/AdminPanelModal.vue'), context)
  vm.runInContext(`editingOrder.value = {id:'old',totalAmount:10,items:[]}; editItems.value = [{name:'Cloth',qty:10,price:2}]; editReason.value = 'correction'`, context)
  await Promise.all([context.saveOrderFix(), context.saveOrderFix()])
  assert.equal(logs.length, 1)
  assert.equal(bill.totalAmount, 20)
})
