import { test as base, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs/dist/exceljs.min.js'
import { mockCloud } from './cloud-fixture.mjs'

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    // Vue production builds can report a render exception through console.error.
    page.on('console', msg => {
      if (msg.type() === 'error' && /TypeError|RangeError|ReferenceError|render function/.test(msg.text())) errors.push(msg.text())
    })
    await use(page)
    expect(errors).toEqual([])
  }
})

const month = '2024-02'
const customer = { id: 'cstFixtureA', name: '甲店', categories: [{ name: '毛巾', price: 2 }] }
const bill = {
  id: 'bllFixtureA', billNo: 'B-17', customerName: '甲店', month, date: '2024-02-29',
  items: [{ name: '毛巾', qty: 3, price: 2 }], totalAmount: 6, status: 'verified'
}
const stats = page => page.getByRole('button', { name: /结算统计/ }).click()
const account = page => page.getByRole('combobox', { name: '结算客户' })
const monthPicker = page => page.getByLabel('结算月份')
const downloadButton = page => page.getByRole('button', { name: /导出结算表 Excel/ })

async function openLedger(page) {
  await page.goto('./?ledger=local')
  await stats(page)
  await expect(downloadButton(page)).toBeVisible()
}

// Seed previously stored/synced rows in a fresh browser context. Normal UI reads
// the real monthly index, so broken rows can be tested without weakening JSON import.
async function setLedger(page, customers, bills) {
  await page.evaluate(async json => {
    if (location.hostname !== '127.0.0.1') throw new Error('Fixtures require an isolated loopback origin')
    const data = JSON.parse(json)
    const db = await new Promise((res, rej) => {
      const open = indexedDB.open('OfflineLedgerCloudDB')
      open.onsuccess = () => res(open.result)
      open.onerror = () => rej(open.error)
    })
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(['customers', 'bills'], 'readwrite')
        tx.oncomplete = res
        tx.onabort = () => rej(tx.error)
        for (const [name, records] of Object.entries(data)) {
          const store = tx.objectStore(name)
          store.clear()
          for (const record of records) store.put(record)
        }
      })
    } finally {
      db.close()
    }
  }, JSON.stringify({ customers, bills }))
}

test('fresh install → enter a bill → settlement → download a readable workbook', async ({ page }) => {
  await openLedger(page)
  await expect(page.locator('header')).toContainText('（0 笔）')
  await page.getByRole('button', { name: /明细/ }).click()
  await page.getByRole('button', { name: /记一笔/ }).click()
  const form = page.locator('.modal-sheet')
  await form.locator('select').first().selectOption({ label: '留香东江酒店' })
  await form.locator('input[type=date]').fill('2024-02-29')
  await form.getByPlaceholder('数量').first().fill('3')
  await form.getByRole('button', { name: '保存本地账单' }).click()
  await expect(form).toHaveCount(0)
  await stats(page)
  await account(page).selectOption({ label: '留香东江酒店' })
  await expect(page.locator('header')).toContainText('2024-02 月度结算总额（1 笔）')
  await expect(page.locator('header')).toContainText('¥ 3.00')
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '台布', exact: true }) })
  await expect(row.getByRole('cell').nth(29)).toHaveText('3')
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton(page).click()])
  expect(download.suggestedFilename()).toBe('留香东江酒店_2024-02_结算表.xlsx')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await readFile(await download.path()))
  const sheet = workbook.worksheets[0]
  expect(sheet.getCell('A1').value).toBe('留香东江酒店')
  expect(sheet.getCell('AE3').value).toBe(3)
  expect(sheet.getCell('AJ17').result).toBe(3)
})

test('damaged bill remains identifiable on both tabs; another customer and month still settle', async ({ page }) => {
  await openLedger(page)
  await setLedger(page, [customer, { id: 'z', name: '乙店' }], [
    { ...bill, items: [null] }, { ...bill, id: 'b2', customerName: '乙店' },
    { ...bill, id: 'b3', month: '2024-03', date: '2024-03-31' }
  ])
  await monthPicker(page).fill(month)
  await expect(page.getByRole('alert')).toContainText('B-17')
  await expect(downloadButton(page)).toHaveCount(0)
  await page.getByRole('button', { name: /明细/ }).click()
  await expect(page.getByText(/这笔账单的明细格式异常/)).toBeVisible()
  await page.getByPlaceholder('搜客户、类目、单号或备注...').fill('毛巾')
  await expect(page.locator('.bill-card')).toHaveCount(1)
  await stats(page)
  await account(page).selectOption({ label: '乙店' })
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await account(page).selectOption({ label: '甲店' })
  await expect(page.getByRole('alert')).toBeVisible()
  await monthPicker(page).fill('2024-03')
  await expect(page.locator('header')).toContainText('甲店 · 2024-03 月度结算总额（1 笔）')
  await expect(downloadButton(page)).toBeEnabled()
})

test('empty ledger and deleted customer profiles cannot merge or mislabel historical totals', async ({ page }) => {
  await openLedger(page)
  await setLedger(page, [], [bill, { ...bill, id: 'b2', customerName: '乙店', totalAmount: 4 }])
  await monthPicker(page).fill('2024-01')
  await expect(page.getByRole('status')).toContainText('暂无可结算的客户')
  await expect(downloadButton(page)).toHaveCount(0)
  await monthPicker(page).fill(month)
  await account(page).selectOption({ label: '甲店' })
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await account(page).selectOption({ label: '乙店' })
  await expect(page.locator('header')).toContainText('¥ 4.00')
  await expect(page.getByRole('button', { name: '定制输出格式' })).toHaveCount(0)
  await monthPicker(page).fill('')
  await expect(page.getByRole('status')).toContainText('请选择结算月份')
  await expect(downloadButton(page)).toHaveCount(0)
})

test('an authorized correction of a damaged line restores the statement and records the original value', async ({ page }) => {
  await openLedger(page)
  await setLedger(page, [customer], [{ ...bill, status: 'pending', items: [null] }])
  await monthPicker(page).fill(month)
  await expect(page.getByRole('alert')).toContainText('B-17')
  await page.getByRole('button', { name: /明细/ }).click()
  await page.getByRole('button', { name: '管理员纠错', exact: true }).click()
  await page.getByPlaceholder('输入管理员口令', { exact: true }).fill('8888')
  await page.getByRole('button', { name: '验证并进入后台' }).click()
  await page.getByPlaceholder('输入新口令（至少6位）').fill('local-fixture')
  await page.getByPlaceholder('再次输入新口令').fill('local-fixture')
  await page.getByRole('button', { name: '保存新口令' }).click()
  await page.getByRole('button', { name: '修正数量 / 单价' }).click()
  const save = page.getByRole('button', { name: '确认覆盖修正并记录日志' })
  const missing = page.waitForEvent('dialog').then(async dialog => {
    const message = dialog.message()
    await dialog.accept()
    return message
  })
  await save.click()
  expect(await missing).toContain('补全每一行')
  const form = page.locator('.modal-sheet')
  await form.getByPlaceholder('类目名', { exact: true }).fill('毛巾')
  await form.getByRole('spinbutton').nth(0).fill('5')
  await form.getByRole('spinbutton').nth(1).fill('2')
  await form.getByPlaceholder(/台布数量多录/).fill('根据测试原单补录')
  await save.click()
  await form.getByRole('button', { name: /改单日志 \(1\)/ }).click()
  await expect(form).toContainText('改前：[null]')
  await form.getByRole('button', { name: '关闭', exact: true }).click()
  await stats(page)
  await expect(page.locator('header')).toContainText('¥ 10.00')
  await expect(downloadButton(page)).toBeEnabled()
})

test('a legacy template can be corrected and saved without changing bill data', async ({ page }) => {
  await openLedger(page)
  await setLedger(page, [{ ...customer, categories: [null, ...customer.categories], exportTemplate: {
    sheetTitle: '专用抬头', statusFilter: 'old-filter',
    tailColumns: [null, { key: 'totalAmount', enabled: true }], extraStatusFields: [null]
  } }], [bill, { ...bill, id: 'b2', status: 'pending' }])
  await monthPicker(page).fill(month)
  await expect(page.getByRole('alert')).toContainText('状态范围无效')
  await expect(downloadButton(page)).toHaveCount(0)
  await page.getByRole('button', { name: '定制输出格式' }).click()
  await page.locator('.modal-sheet select').selectOption('verified')
  const saved = page.waitForEvent('dialog').then(async dialog => {
    const result = dialog.message()
    await dialog.accept()
    return result
  })
  await page.getByRole('button', { name: /保存为.*专属输出格式/ }).click()
  expect(await saved).toContain('专属输出格式已保存')
  await expect(page.locator('header')).toContainText('（1 笔）')
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await expect(page.getByText('专用抬头（实时预览）')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: '总额' })).toBeVisible()
  await page.getByRole('button', { name: /客户设置/ }).click()
  await expect(page.getByText(/应用版本 \d+\.\d+\.\d+/)).toBeVisible()
  await expect(page.getByText('第 1 项类目格式异常')).toBeVisible()
})

test('failed month read hides old amounts and offers a working retry', async ({ page }) => {
  // Dexie binds transaction() on open. Install the fault before boot, then arm
  // it for the target month after the first successful read.
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
      if (window.failNextLedgerRead && mode === 'readonly' && Array.from(stores).includes('bills')) {
        window.failNextLedgerRead = false
        throw new DOMException('Test ledger read failure', 'NotReadableError')
      }
      return original.call(this, stores, mode, ...options)
    }
  })
  await openLedger(page)
  await setLedger(page, [customer], [bill])
  await monthPicker(page).fill(month)
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await page.evaluate(() => { window.failNextLedgerRead = true })
  await monthPicker(page).fill('2024-03')
  await expect(page.getByRole('alert')).toContainText('账本读取失败')
  await expect(page.locator('header')).not.toContainText('¥ 6.00')
  await expect(downloadButton(page)).toHaveCount(0)
  await page.getByRole('button', { name: '重新读取账本' }).click()
  await expect(page.locator('header')).toContainText('甲店 · 2024-03 月度结算总额（0 笔）')
  await expect(downloadButton(page)).toBeEnabled()
})

test('a large monthly statement remains readable and scrolls within the mobile viewport', async ({ page }) => {
  test.setTimeout(120000) // Includes the initial IndexedDB import, before timing page assertions.
  await page.setViewportSize({ width: 320, height: 568 })
  await openLedger(page)
  const bills = Array.from({ length: 2000 }, (_, i) => ({ ...bill, id: 'bll' + i,
    items: [{ name: '类目' + i % 100, qty: 3, price: 2 }] }))
  await setLedger(page, [customer], bills)
  await monthPicker(page).fill(month)
  await expect(page.locator('header')).toContainText('（2000 笔）')
  await expect(page.locator('header')).toContainText('¥ 12000.00')
  await expect(page.getByRole('row')).toHaveCount(103)
  const layout = await page.locator('.matrix-scroll').evaluate(el => ({
    fits: el.getBoundingClientRect().right <= document.documentElement.clientWidth,
    scrolls: el.scrollWidth > el.clientWidth
  }))
  expect(layout).toEqual({ fits: true, scrolls: true })
})

test('cached production app reopens offline and settles the same IndexedDB bill', async ({ page, context }) => {
  await openLedger(page)
  await setLedger(page, [customer], [bill])
  await monthPicker(page).fill(month)
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await context.setOffline(true)
  await page.reload()
  await stats(page)
  await monthPicker(page).fill(month)
  await expect(page.locator('header')).toContainText('甲店 · 2024-02 月度结算总额（1 笔）')
  await expect(page.locator('header')).toContainText('¥ 6.00')
  await expect(downloadButton(page)).toBeEnabled()
})

test.describe('synced ledger', () => {
  // Intercept only our test endpoint. Offline service-worker coverage runs separately.
  test.use({ serviceWorkers: 'block' })
  test('saved cloud URL, login, second-tab sync and later customer arrival update an open settlement', async ({ page, context }) => {
    const cloud = await mockCloud(context)
    cloud.publish({ bills: [bill] })
    await page.goto('./')
    await stats(page)
    await expect(page.getByRole('status')).toContainText('暂无可结算的客户')
    await page.getByRole('button', { name: /明细/ }).click()
    await page.getByRole('button', { name: /登录同步/ }).click()
    await page.locator('input[type=email]').fill(cloud.email)
    await page.getByRole('button', { name: '发送验证码并登录云同步' }).click()
    await expect(page.getByText('邮箱已验证，云账本已同步')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await stats(page)
    await monthPicker(page).fill(month)
    await expect(page.locator('header')).toContainText('¥ 6.00')
    await expect(page.getByRole('button', { name: '定制输出格式' })).toHaveCount(0)

    const second = await context.newPage()
    await second.goto('./')
    await second.getByRole('button', { name: new RegExp(cloud.email) }).click()
    await expect(second.getByText('已登录：' + cloud.email)).toBeVisible()
    cloud.publish({ customers: [customer], bills: [{ ...bill, items: [null] }] })
    await second.getByRole('button', { name: '立即云端同步' }).click()
    await expect(page.getByRole('alert')).toContainText('B-17', { timeout: 15000 })
    await expect(downloadButton(page)).toHaveCount(0)
    await expect(account(page).locator('option:checked')).toHaveText('甲店')
    cloud.publish({ bills: [{ ...bill, items: [{ name: '毛巾', qty: 4, price: 2 }], totalAmount: 8 }] })
    await second.getByRole('button', { name: '立即云端同步' }).click()
    await expect(page.locator('header')).toContainText('¥ 8.00', { timeout: 15000 })
    await expect(page.getByRole('button', { name: '定制输出格式' })).toBeVisible()
    await expect(downloadButton(page)).toBeEnabled()
    await second.close()
  })
})
