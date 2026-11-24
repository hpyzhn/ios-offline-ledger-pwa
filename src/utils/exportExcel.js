import ExcelJS from 'exceljs'
import { getMonthLastDateParts } from './rmb.js'
import { allocateBillCents, hasNamedBillItems } from './money.js'

function colToLetter(colNum1Based) {
  let s = ''
  let n = colNum1Based
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// 防止用户可控文本（客户名/类目/备注等）被 Excel 当作公式执行（公式注入）
function sanitizeCell(value) {
  if (value === null || value === undefined) return null
  const s = String(value)
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s
}

const THIN_BORDER = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
}

const CENTER_ALIGN = { horizontal: 'center', vertical: 'center' }

function ledgerNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return NaN
  return Number(value)
}

/**
 * 计算月度 1~31 日横向矩阵数据（用于页面实时预览与 Excel 导出）
 */
export function buildSettlementPreview({ month, customer, bills, template, fallbackTitle }) {
  if (typeof customer?.name !== 'string' || !customer.name.trim()) throw new Error('请选择要结算的客户。')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效的结算月份。')
  const dateParts = getMonthLastDateParts(month)
  const statusFilter = template?.statusFilter || 'all'
  if (!['all', 'pending', 'verified'].includes(statusFilter)) {
    throw new Error('模板中的账单状态范围无效，请在「定制输出格式」中重新选择。')
  }
  const filteredBills = (bills || []).filter((b) => {
    if (b?.customerName !== customer.name) return false
    if (b.month && b.month !== month) return false
    if (statusFilter !== 'all' && (b.status || 'pending') !== statusFilter) return false
    return true
  })

  const categoryOrder = []
  const categoryMap = new Map()
  const categoryPrices = new Map()
  const details = []

  ;(Array.isArray(customer?.categories) ? customer.categories : []).forEach((c) => {
    if (typeof c?.name !== 'string' || !c.name.trim()) return
    if (categoryMap.has(c.name)) return
    const price = ledgerNumber(c.price)
    if (Number.isFinite(price) && (c.enabled !== false || !categoryPrices.has(c.name))) {
      categoryPrices.set(c.name, price)
    }
    if (c.enabled === false) return
    categoryOrder.push(c.name)
    categoryMap.set(c.name, {
      name: c.name,
      unit: c.unit || '',
      price: categoryPrices.get(c.name) ?? 0,
      days: Array(31).fill(0),
      totalQty: 0,
      totalAmount: 0,
      verifiedCount: 0,
      pendingCount: 0,
      remarks: new Set()
    })
  })

  filteredBills.forEach((b) => {
    function invalid(reason) {
      throw new Error(`账单「${b.billNo || b.id || b.date || '未知'}」${reason}，请核对原始单据。`)
    }
    const day = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? Number(b.date.slice(8)) : 0
    if (!day || day > dateParts.day || b.date.slice(0, 7) !== month) invalid('的日期与结算月份不符')
    if (!hasNamedBillItems(b.items)) invalid('的明细格式异常')
    const savedTotal = b.totalAmount == null ? undefined : ledgerNumber(b.totalAmount)
    if (savedTotal !== undefined && (savedTotal < 0 || !Number.isSafeInteger(Math.round(savedTotal * 100)))) invalid('的已存金额无效')
    if (!b.items.length && savedTotal) invalid('有金额但缺少明细')
    const items = b.items.map(item => {
      const qty = ledgerNumber(item.qty)
      const price = item.price == null ? categoryPrices.get(item.name) : ledgerNumber(item.price)
      if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(price) || price < 0) invalid(`的「${item.name}」数量或单价无效`)
      if (!Number.isSafeInteger(Math.round(qty * price * 100))) invalid('的明细金额超出有效范围')
      return { ...item, qty, price }
    })
    const amounts = allocateBillCents(items, savedTotal)
    if (!amounts.every(Number.isSafeInteger)) invalid('的金额超出有效范围')
    details.push({ bill: b, items, amounts })
    items.forEach((it, index) => {
      if (!categoryMap.has(it.name)) {
        categoryOrder.push(it.name)
        categoryMap.set(it.name, {
          name: it.name,
          unit: it.unit || '',
          price: Number(it.price) || 0,
          days: Array(31).fill(0),
          totalQty: 0,
          totalAmount: 0,
          verifiedCount: 0,
          pendingCount: 0,
          remarks: new Set()
        })
      }
      const row = categoryMap.get(it.name)
      row.days[day - 1] = Number((row.days[day - 1] + it.qty).toFixed(3))
      row.totalAmount = (Math.round(row.totalAmount * 100) + amounts[index]) / 100
      if (b.status === 'verified') row.verifiedCount += 1
      else row.pendingCount += 1
      if (b.remark) row.remarks.add(b.remark)
    })
  })

  // 让 totalQty 始终等于各日列之和，避免与 Excel 的 SUM(C:AG) 公式结果不一致
  categoryOrder.forEach((name) => {
    const r = categoryMap.get(name)
    r.totalQty = Number(r.days.reduce((s, d) => s + d, 0).toFixed(3))
  })

  const includeZero = template?.includeZeroRows !== false
  const rows = categoryOrder
    .map((name) => categoryMap.get(name))
    .filter((r) => includeZero || r.totalQty !== 0 || r.totalAmount !== 0)

  const activeTailCols = (Array.isArray(template?.tailColumns) ? template.tailColumns : []).filter((c) => c && c.enabled)
  const grandTotal = Number(rows.reduce((s, r) => s + r.totalAmount, 0).toFixed(2))
  const grandQty = Number(rows.reduce((s, r) => s + r.totalQty, 0).toFixed(3))
  if (!Number.isSafeInteger(Math.round(grandTotal * 100)) || !Number.isFinite(grandQty)) {
    throw new Error('本月合计超出有效范围，请核对账单。')
  }

  return {
    filteredBills,
    customerName: customer.name,
    sheetTitle: template?.sheetTitle || fallbackTitle || '广州市羽洁洗涤厂结算表',
    settlementDate: dateParts.text,
    settlementDateObj: dateParts.dateObj,
    rows,
    activeTailCols,
    grandTotal,
    grandQty,
    details
  }
}

/**
 * 1:1 严格还原《留香东江结算表.xls》的默认格式与样式，同时兼容客户自定义的动态列/状态行
 */
export async function exportSettlementExcel({ month, customer, bills, template, fallbackTitle }) {
  const data = buildSettlementPreview({ month, customer, bills, template, fallbackTitle })
  const wb = new ExcelJS.Workbook()

  const ws = wb.addWorksheet('Sheet1', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1
    }
  })

  const tailCount = data.activeTailCols.length
  const totalCols = 2 + 31 + tailCount // 默认 36 列：A:B(2) + C..AG(31) + AH..AJ(3)

  // 列宽设置
  ws.getColumn(1).width = 4.2
  ws.getColumn(2).width = 4.2
  for (let c = 3; c <= 33; c++) {
    ws.getColumn(c).width = 4.2
  }
  data.activeTailCols.forEach((col, idx) => {
    const c = 34 + idx
    if (col.key === 'totalQty') ws.getColumn(c).width = 6.2
    else if (col.key === 'unitPrice') ws.getColumn(c).width = 5.5
    else if (col.key === 'totalAmount') ws.getColumn(c).width = 8.2
    else ws.getColumn(c).width = 11
  })

  // ==================== 第 1 行：三段合并表头 ====================
  // A1:J1 客户名(16pt) | K1:AG1 结算表标题(18pt) | AH1..末列 结算日期(12pt, m/d/yyyy)
  ws.getRow(1).height = 24.95
  ws.mergeCells(1, 1, 1, 10)
  ws.mergeCells(1, 11, 1, 33)
  if (totalCols >= 34) {
    ws.mergeCells(1, 34, 1, totalCols)
  }

  const cTitleLeft = ws.getCell(1, 1)
  cTitleLeft.value = sanitizeCell(data.customerName)
  cTitleLeft.font = { name: '宋体', size: 16 }
  cTitleLeft.alignment = CENTER_ALIGN

  const cTitleMid = ws.getCell(1, 11)
  cTitleMid.value = sanitizeCell(data.sheetTitle)
  cTitleMid.font = { name: '宋体', size: 18 }
  cTitleMid.alignment = CENTER_ALIGN

  if (totalCols >= 34 && template?.showDate !== false) {
    const cDate = ws.getCell(1, 34)
    cDate.value = data.settlementDateObj
    cDate.numFmt = 'm/d/yyyy'
    cDate.font = { name: '宋体', size: 12 }
    cDate.alignment = CENTER_ALIGN
  }
  for (let c = 1; c <= totalCols; c++) {
    ws.getCell(1, c).border = THIN_BORDER
  }

  // ==================== 第 2 行：列标题（名称 | 1..31 | 总数 单价 总额...） ====================
  ws.getRow(2).height = 24.95
  ws.mergeCells(2, 1, 2, 2)
  const cNameHead = ws.getCell(2, 1)
  cNameHead.value = '名称'
  cNameHead.font = { name: '宋体', size: 12 }
  cNameHead.alignment = CENTER_ALIGN

  for (let d = 1; d <= 31; d++) {
    const cell = ws.getCell(2, 2 + d)
    cell.value = d
    cell.font = { name: '宋体', size: 12 }
    cell.alignment = CENTER_ALIGN
  }

  data.activeTailCols.forEach((col, idx) => {
    const cell = ws.getCell(2, 34 + idx)
    cell.value = sanitizeCell(col.label)
    cell.font = { name: '宋体', size: 12 }
    cell.alignment = CENTER_ALIGN
  })
  for (let c = 1; c <= totalCols; c++) {
    ws.getCell(2, c).border = THIN_BORDER
  }

  // ==================== 第 3 ~ (2+slotCount) 行：类目数据区（默认严格 14 行，即第 3~16 行） ====================
  // 上限钳制：损坏/恶意模板中的超大行数会让导出循环百万次导致页面卡死
  const minDataRows = Number.isInteger(template?.minDataRows) ? Math.min(Math.max(template.minDataRows, 0), 200) : 14
  const slotCount = Math.max(minDataRows, data.rows.length)

  const qtyIdx = data.activeTailCols.findIndex((c) => c.key === 'totalQty')
  const priceIdx = data.activeTailCols.findIndex((c) => c.key === 'unitPrice')
  const amountIdx = data.activeTailCols.findIndex((c) => c.key === 'totalAmount')

  for (let i = 0; i < slotCount; i++) {
    const r = 3 + i
    const item = data.rows[i] || null
    ws.getRow(r).height = 24.95
    ws.mergeCells(r, 1, r, 2)

    const cName = ws.getCell(r, 1)
    cName.value = item ? sanitizeCell(item.name) : null
    cName.font = { name: '宋体', size: item ? 11 : 10 }
    cName.alignment = CENTER_ALIGN

    for (let d = 0; d < 31; d++) {
      const cell = ws.getCell(r, 3 + d)
      cell.value = item && item.days[d] !== 0 ? item.days[d] : null
      cell.font = { name: '宋体', size: 9 }
      cell.alignment = CENTER_ALIGN
    }

    data.activeTailCols.forEach((col, idx) => {
      const c = 34 + idx
      const cell = ws.getCell(r, c)
      cell.font = { name: '宋体', size: 10 }
      cell.alignment = CENTER_ALIGN

      if (!item) {
        cell.value = null
        return
      }
      if (col.key === 'totalQty') {
        cell.value = { formula: `SUM(C${r}:AG${r})`, result: item.totalQty }
      } else if (col.key === 'unitPrice') {
        cell.value = item.price
      } else if (col.key === 'totalAmount') {
        cell.value = item.totalAmount
      } else if (col.key === 'unit') {
        cell.value = sanitizeCell(item.unit || '')
      } else if (col.key === 'verifyStatus') {
        if (item.verifiedCount === 0 && item.pendingCount === 0) cell.value = ''
        else if (item.pendingCount === 0) cell.value = '已核销'
        else if (item.verifiedCount === 0) cell.value = '未核销'
        else cell.value = `已核${item.verifiedCount}/待核${item.pendingCount}`
      } else if (col.key === 'remark') {
        cell.value = sanitizeCell(Array.from(item.remarks).join('；'))
      } else {
        cell.value = sanitizeCell(col.defaultValue || '')
      }
    })

    for (let c = 1; c <= totalCols; c++) {
      ws.getCell(r, c).border = THIN_BORDER
    }
  }

  // ==================== 第 17 行（或 3+slotCount）：总计行（严格还原 AJ17，A17:B17 默认留空） ====================
  let nextRow = 3 + slotCount
  if (template?.includeTotalRow !== false) {
    const r = nextRow
    ws.getRow(r).height = 24.95
    ws.mergeCells(r, 1, r, 2)
    const cLabel = ws.getCell(r, 1)
    cLabel.value = template?.showTotalLabel ? '合计' : null
    cLabel.font = { name: '宋体', size: 10 }
    cLabel.alignment = CENTER_ALIGN

    if (amountIdx >= 0) {
      const aCol = 34 + amountIdx
      const aLet = colToLetter(aCol)
      const cTotal = ws.getCell(r, aCol)
      cTotal.value = slotCount ? { formula: `SUM(${aLet}3:${aLet}${2 + slotCount})`, result: data.grandTotal } : 0
      cTotal.font = { name: '宋体', size: 12 }
      cTotal.alignment = CENTER_ALIGN
    }

    for (let c = 1; c <= totalCols; c++) {
      ws.getCell(r, c).border = THIN_BORDER
    }
    nextRow += 1
  }

  // ==================== 第 18~20 行：原表底部 3 行空白合并行 ====================
  const trailingBlankRows = Number.isInteger(template?.trailingBlankRows) ? Math.min(Math.max(template.trailingBlankRows, 0), 50) : 3
  for (let b = 0; b < trailingBlankRows; b++) {
    const r = nextRow + b
    ws.getRow(r).height = 24.95
    ws.mergeCells(r, 1, r, 2)
    for (let c = 1; c <= totalCols; c++) {
      ws.getCell(r, c).border = THIN_BORDER
    }
  }
  nextRow += trailingBlankRows

  // ==================== 用户自定义的底部附加状态/签字行 ====================
  ;(Array.isArray(template?.extraStatusFields) ? template.extraStatusFields : []).forEach((field) => {
    if (!field || !field.label) return
    const r = nextRow
    ws.getRow(r).height = 24.95
    ws.mergeCells(r, 1, r, Math.min(12, totalCols))
    const cell = ws.getCell(r, 1)
    cell.value = sanitizeCell(`${field.label}：${field.value || ''}`)
    cell.font = { name: '宋体', size: 11 }
    cell.alignment = { horizontal: 'left', vertical: 'center' }
    nextRow += 1
  })

  // 与原表一致保留 Sheet2、Sheet3；如用户开启附带明细表则生成「每笔交易明细」
  if (template?.includeDetailSheet) {
    const wsDetail = wb.addWorksheet('每笔交易明细')
    wsDetail.columns = [
      { header: '单号', key: 'billNo', width: 18 },
      { header: '日期', key: 'date', width: 12 },
      { header: '客户', key: 'customerName', width: 16 },
      { header: '类目', key: 'name', width: 12 },
      { header: '单位', key: 'unit', width: 6 },
      { header: '数量', key: 'qty', width: 8 },
      { header: '单价', key: 'price', width: 8 },
      { header: '小计', key: 'subtotal', width: 10 },
      { header: '收款方式', key: 'paymentMethod', width: 10 },
      { header: '核销状态', key: 'status', width: 10 },
      { header: '备注', key: 'remark', width: 18 }
    ]
    data.details.forEach(({ bill: b, items, amounts }) => {
      items.forEach((it, index) => {
        wsDetail.addRow({
          billNo: sanitizeCell(b.billNo),
          date: sanitizeCell(b.date),
          customerName: sanitizeCell(b.customerName),
          name: sanitizeCell(it.name),
          unit: sanitizeCell(it.unit || ''),
          qty: Number(it.qty) || 0,
          price: Number(it.price) || 0,
          subtotal: amounts[index] / 100,
          paymentMethod: sanitizeCell(b.paymentMethod || '月结挂账'),
          status: b.status === 'verified' ? '已核销' : '未核销',
          remark: sanitizeCell(b.remark || '')
        })
      })
    })
  } else {
    wb.addWorksheet('Sheet2')
    wb.addWorksheet('Sheet3')
  }

  // 触发纯本地浏览器下载 .xlsx
  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const safeCustomer = data.customerName.replace(/[\\/:*?"<>|]/g, '_')
  a.href = url
  a.download = `${safeCustomer}_${month}_结算表.xlsx`
  a.click()
  if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 1000)
  else URL.revokeObjectURL(url)
}
