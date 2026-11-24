import { billTotal, allocateBillCents } from '../src/utils/money.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ExcelJS from 'exceljs'
import { parseSmartBatchText } from '../src/utils/smartParser.js'
import { getMonthLastDateParts } from '../src/utils/rmb.js'
import { webcrypto } from 'node:crypto'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
function script(path) {
  return read(path).split('<script setup>')[1].split('</script>')[0]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
}

test('smart parser loads and preserves explicit prices', () => {
  assert.equal(parseSmartBatchText('Hotel 2026-11-21 Cloth10*2')[0].totalAmount, 20)
})

test('export preserves historical and zero prices in actual workbook', async () => {
  let output
  const context = vm.createContext({ ExcelJS, getMonthLastDateParts, allocateBillCents,
    Blob, URL: { createObjectURL(blob) { output = blob; return 'blob:test' }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) }
  })
  vm.runInContext(read('../src/utils/exportExcel.js').replace(/^import .*$/gm, '').replace(/export /g, ''), context)
  const input = { month: '2026-11', customer: { name: 'A', categories: [{ name: 'Cloth', price: 2 }] },
    bills: [1, 2, 0].map(price => ({ customerName: 'A', date: '2026-11-21', items: [{ name: 'Cloth', qty: 10, price }] })),
    template: { tailColumns: [{key:'totalQty',enabled:true}, {key:'unitPrice',enabled:true}, {key:'totalAmount',enabled:true}] } }
  assert.equal(context.buildSettlementPreview(input).grandTotal, 30)
  await context.exportSettlementExcel(input)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await output.arrayBuffer())
  let found = false
  wb.worksheets[0].eachRow(row => {
    if (row.values.includes('Cloth')) {
      assert.equal(row.getCell(36).value, 30)
      found = true
    }
  })
  assert(found)

  const fractional = {
    ...input,
    template: { ...input.template, includeDetailSheet: true },
    bills: [{
      customerName: 'A', date: '2026-11-21', totalAmount: 0.01,
      items: ['Cloth', 'Towel'].map(name => ({ name, qty: 0.6, price: 0.01 }))
    }]
  }
  assert.equal(context.buildSettlementPreview(fractional).grandTotal, 0.01)
  await context.exportSettlementExcel(fractional)
  await wb.xlsx.load(await output.arrayBuffer())
  const amounts = []
  wb.worksheets[0].eachRow(row => {
    if (row.values.includes('Cloth') || row.values.includes('Towel')) amounts.push(row.getCell(36).value)
  })
  assert.deepEqual(amounts, [0.01, 0])
  const detail = wb.getWorksheet('每笔交易明细')
  assert.equal(detail.getCell('H2').value + detail.getCell('H3').value, 0.01)
})

test('admin total uses saved rows and audit failure rolls back bill', async () => {
  const original = { id: 'old', totalAmount: 10, items: [] }
  let bill = structuredClone(original)
  let fail = true
  const db = {
    bills: { update: async (_, change) => Object.assign(bill, change), get: async () => structuredClone(bill), orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) },
    auditLogs: { add: async () => { if (fail) throw Error('audit failure') }, orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    transaction: async (...args) => { const before = structuredClone(bill); try { await args.at(-1)() } catch(e) { bill = before; throw e } }
  }
  const context = vm.createContext({db, billTotal, ref: value => ({value}), computed: fn => ({get value(){return fn()}}), watch(){}, defineProps:()=>({}), defineEmits:()=>()=>{}, alert(){}})
  vm.runInContext(script('../src/components/AdminPanelModal.vue'), context)
  vm.runInContext(`editingOrder.value = {id:'old',totalAmount:10,items:[]}; editItems.value = [{name:'Cloth',qty:10,price:2},{name:'',qty:5,price:100}]; editReason.value = 'correction'`, context)
  await assert.rejects(context.saveOrderFix(), /audit failure/)
  assert.deepEqual(bill, original)
  fail = false
  await context.saveOrderFix()
  assert.equal(bill.totalAmount, 20)
  assert.equal(bill.items.length, 1)
})

function appContext(db) {
  return vm.createContext({ db, billTotal, syncCloudLedger: () => db.cloud.sync(), ref: value => ({value}), watch(){}, onMounted(){}, onUnmounted(){},
    navigator: {onLine:true}, cloudConfigured:true, alert(){}, setTimeout(){},
    createDefaultExportTemplate:()=>({}), generateNextBillNo:async()=>webcrypto.randomUUID() })
}

test('failed upload leaves pending; edits during upload are not acknowledged', async () => {
  let bill = {id:'existing', syncStatus:'pending', updatedAt:1, totalAmount:10}
  const db = { bills: {where:()=>({equals:()=>({toArray:async()=>[structuredClone(bill)]})}), get:async()=>bill,
    update:async(_,change)=>Object.assign(bill,change)}, transaction:async(...args)=>args.at(-1)(),
    cloud:{sync:async()=>{throw Error('offline')}} }
  const context = appContext(db)
  vm.runInContext(script('../src/App.vue'), context)
  vm.runInContext('currentUser.value = {isLoggedIn:true}; loadData = async () => {}',context)
  await context.autoCheckAndUploadOfflineData()
  assert.equal(bill.syncStatus,'pending')
  db.cloud.sync = async()=> { bill.totalAmount = 20 }
  await context.autoCheckAndUploadOfflineData()
  assert.equal(bill.syncStatus,'pending')
  db.cloud.sync = async()=>{}
  await context.autoCheckAndUploadOfflineData()
  assert.equal(bill.syncStatus,'synced')
})

test('batch failure rolls back new customers and bills, preserves existing data', async () => {
  let bills = [{id:'existing', date:'2026-11-20', customerName:'Original'}]
  let customers = [{name:'Original'}]
  const initial = structuredClone({bills,customers})
  const db = {
    bills: {where:()=>({equals:date=>({toArray:async()=>bills.filter(b=>b.date===date)})}),add:async b=>bills.push(b)},
    customers:{where:()=>({equals:name=>({first:async()=>customers.find(c=>c.name===name)})}),add:async c=>customers.push(c)},
    transaction:async(...args)=>{const saved=structuredClone({bills,customers});try{await args.at(-1)()}catch(e){({bills,customers}=saved);throw e}}
  }
  const context = appContext(db)
  vm.runInContext(script('../src/App.vue'),context)
  vm.runInContext('showSmartImport.value = true',context)
  await context.handleConfirmSmartImport([
    {customerName:'New',date:'2026-11-21',items:[{name:'Cloth',qty:10,price:1}]},
    {customerName:'Invalid',date:'2026-11-21',items:[{name:'Cloth',qty:-1,price:1}]}
  ])
  assert.deepEqual({bills,customers},initial)
  assert.equal(vm.runInContext('showSmartImport.value',context),true)
  assert.equal(vm.runInContext('importing.value',context),false)
})

test('new bill numbers do not depend on existing count', async () => {
  const context=vm.createContext({crypto:webcrypto})
  vm.runInContext(read('../src/db/database.js').slice(read('../src/db/database.js').indexOf('export async function generateNextBillNo')).replace('export ',''),context)
  const ids=await Promise.all(Array.from({length:1000},()=>context.generateNextBillNo('2026-11-21')))
  assert.equal(new Set(ids).size,1000)
})
