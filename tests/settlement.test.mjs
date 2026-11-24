import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSettlementPreview, exportSettlementExcel } from '../src/utils/exportExcel.js'

const customer = { name: '甲', categories: [{ name: '台布', price: 2 }] }
const bill = { billNo: 'B-17', customerName: '甲', date: '2024-02-29', items: [{ name: '台布', qty: 3, price: 1.5 }] }
const input = { month: '2024-02', customer, bills: [bill] }

for (const [label, change] of [
  ['null detail', { items: [null] }],
  ['sparse array of details', { items: Array(1) }],
  ['non-array details', { items: { length: 1 } }],
  ['missing details', { items: undefined }],
  ['empty details with a saved amount', { items: [], totalAmount: 10 }],
  ['unnamed item', { items: [{ name: ' ', qty: 1, price: 1 }] }],
  ['missing quantity', { items: [{ name: '台布', price: 2 }] }],
  ['blank quantity', { items: [{ name: '台布', qty: '  ', price: 2 }] }],
  ['non-numeric quantity', { items: [{ name: '台布', qty: 'x', price: 2 }] }],
  ['non-finite price', { items: [{ name: '台布', qty: 1, price: Infinity }] }],
  ['negative price', { items: [{ name: '台布', qty: 1, price: -2 }] }],
  ['negative quantity', { items: [{ name: '台布', qty: -1, price: 2 }] }],
  ['unknown historical price', { items: [{ name: '毛巾', qty: 2 }] }],
  ['overflow amount', { items: [{ name: '台布', qty: 1e200, price: 1e200 }] }],
  ['invalid saved total', { totalAmount: '不是金额' }],
  ['negative saved total', { totalAmount: -1 }],
  ['missing date', { date: null }],
  ['non-string date', { date: 20240229 }],
  ['nonexistent day', { date: '2024-02-30' }],
  ['inconsistent month index', { month: '2024-02', date: '2024-03-01' }]
]) {
  test('invalid bill is identified before preview or download: ' + label, async () => {
    const args = { ...input, bills: [{ ...bill, ...change }] }
    assert.throws(() => buildSettlementPreview(args), /账单「B-17」/)
    await assert.rejects(exportSettlementExcel(args), /账单「B-17」/)
  })
}

test('legacy prices, free items and saved cents survive malformed optional category entries', () => {
  const data = buildSettlementPreview({
    ...input, customer: { ...customer, categories: [null, { name: '台布', enabled: false, price: 99 }, ...customer.categories, ...customer.categories] },
    bills: [
      { ...bill, items: [{ name: '台布', qty: '2' }] },
      { ...bill, items: [{ name: '台布', qty: 1, price: 0 }] },
      { ...bill, items: [{ name: '台布', qty: 1, price: 0.125 }], totalAmount: '0.13' }
    ]
  })
  assert.equal(data.filteredBills.length, 3)
  assert.equal(data.rows.length, 1)
  assert.equal(data.rows[0].days[28], 4)
  assert.equal(data.grandTotal, 4.13)
  assert.equal(data.settlementDate, '2024-02-29')
})

test('no customer or invalid month cannot produce a mislabeled settlement', () => {
  assert.throws(() => buildSettlementPreview({ ...input, customer: null }), /客户/)
  for (const month of ['', '2024-00', '2024-13']) {
    assert.throws(() => buildSettlementPreview({ ...input, month }), /月份/)
  }
})

test('an unrelated bad bill cannot block the selected customer, month or status', () => {
  const broken = { ...bill, items: [null] }
  const data = buildSettlementPreview({
    ...input, template: { statusFilter: 'pending' }, bills: [
      bill, { ...broken, customerName: '乙' }, { ...broken, month: '2024-03' }, { ...broken, status: 'verified' }
    ]
  })
  assert.equal(data.filteredBills.length, 1)
  assert.equal(data.grandTotal, 4.5)
})

test('monthly matrix reconciles 5,000 bills to independent per-day quantities and integer cents', () => {
  const bills = []
  const days = Array(31).fill(0)
  let cents = 0
  let count = 0
  for (let i = 0; i < 5000; i++) {
    const qty = i % 9 + 1
    const priceCents = i % 37
    const day = i % 29
    const customerName = i % 3 ? '甲' : '乙'
    const status = i % 4 ? 'pending' : 'verified'
    bills.push({ customerName, status, date: '2024-02-' + String(day + 1).padStart(2, '0'),
      items: [{ name: '类目' + i % 51, qty, price: priceCents / 100 }] })
    if (customerName === '甲' && status === 'pending') {
      cents += priceCents * qty
      days[day] += qty
      count++
    }
  }
  const data = buildSettlementPreview({ ...input, bills, template: { statusFilter: 'pending', includeZeroRows: false } })
  assert.equal(data.filteredBills.length, count)
  assert.equal(data.grandTotal, cents / 100)
  assert.equal(data.grandQty, days.reduce((sum, n) => sum + n, 0))
  assert.deepEqual(days.map((_, i) => data.rows.reduce((sum, row) => sum + row.days[i], 0)), days)
})
