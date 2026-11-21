import ExcelJS from 'exceljs'
import { getMonthLastDateParts } from './rmb'

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

const THIN_BORDER = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
}

const CENTER_ALIGN = { horizontal: 'center', vertical: 'center' }

/**
 * 计算月度 1~31 日横向矩阵数据（用于页面实时预览与 Excel 导出）
 */
export function buildSettlementPreview({ month, customer, bills, template, fallbackTitle }) {
  const statusFilter = template?.statusFilter || 'all'
  const filteredBills = (bills || []).filter((b) => {
    if (customer && b.customerName !== customer.name) return false
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    return true
  })

  const categoryOrder = []
  const categoryMap = new Map()

  ;(customer?.categories || []).forEach((c) => {
    if (c.enabled === false) return
    categoryOrder.push(c.name)
    categoryMap.set(c.name, {
      name: c.name,
      unit: c.unit || '',
      price: Number(c.price) || 0,
      days: Array(31).fill(0),
      totalQty: 0,
      totalAmount: 0,
      verifiedCount: 0,
      pendingCount: 0,
      remarks: new Set()
    })
  })

  filteredBills.forEach((b) => {
    const dayNum = Number((b.date || '').slice(8, 10))
    const dayIdx = dayNum >= 1 && dayNum <= 31 ? dayNum - 1 : -1

    ;(b.items || []).forEach((it) => {
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
      const qty = Number(it.qty) || 0
      const price = Number(it.price)
      if (dayIdx >= 0 && qty !== 0) {
        row.days[dayIdx] = Number((row.days[dayIdx] + qty).toFixed(3))
      }
      row.totalQty = Number((row.totalQty + qty).toFixed(3))
      const itemPrice = Number.isFinite(price) && price > 0 ? price : row.price
      row.totalAmount = Number((row.totalAmount + qty * itemPrice).toFixed(2))
      if (b.status === 'verified') row.verifiedCount += 1
      else row.pendingCount += 1
      if (b.remark) row.remarks.add(b.remark)
    })
  })

  const includeZero = template?.includeZeroRows !== false
  const rows = categoryOrder
    .map((name) => categoryMap.get(name))
    .filter((r) => includeZero || r.totalQty !== 0)

  const activeTailCols = (template?.tailColumns || []).filter((c) => c.enabled)
  const grandTotal = Number(rows.reduce((s, r) => s + r.totalAmount, 0).toFixed(2))
  const grandQty = Number(rows.reduce((s, r) => s + r.totalQty, 0).toFixed(3))
  const dateParts = getMonthLastDateParts(month)

  return {
    customerName: customer?.name || '留香东江酒店',
    sheetTitle: template?.sheetTitle || fallbackTitle || '广州市羽洁洗涤厂结算表',
    settlementDate: dateParts.text,
    settlementDateObj: dateParts.dateObj,
    rows,
    activeTailCols,
    grandTotal,
    grandQty,
    filteredBills
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
  cTitleLeft.value = data.customerName
  cTitleLeft.font = { name: '宋体', size: 16 }
  cTitleLeft.alignment = CENTER_ALIGN

  const cTitleMid = ws.getCell(1, 11)
  cTitleMid.value = data.sheetTitle
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
    cell.value = col.label
    cell.font = { name: '宋体', size: 12 }
    cell.alignment = CENTER_ALIGN
  })
  for (let c = 1; c <= totalCols; c++) {
    ws.getCell(2, c).border = THIN_BORDER
  }

  // ==================== 第 3 ~ (2+slotCount) 行：类目数据区（默认严格 14 行，即第 3~16 行） ====================
  const minDataRows = Number.isInteger(template?.minDataRows) ? template.minDataRows : 14
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
    cName.value = item ? item.name : null
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
        if (qtyIdx >= 0 && priceIdx >= 0) {
          const qLet = colToLetter(34 + qtyIdx)
          const pLet = colToLetter(34 + priceIdx)
          cell.value = { formula: `SUM(${qLet}${r}*${pLet}${r})`, result: item.totalAmount }
        } else {
          cell.value = item.totalAmount
        }
      } else if (col.key === 'unit') {
        cell.value = item.unit || ''
      } else if (col.key === 'verifyStatus') {
        if (item.verifiedCount === 0 && item.pendingCount === 0) cell.value = ''
        else if (item.pendingCount === 0) cell.value = '已核销'
        else if (item.verifiedCount === 0) cell.value = '未核销'
        else cell.value = `已核${item.verifiedCount}/待核${item.pendingCount}`
      } else if (col.key === 'remark') {
        cell.value = Array.from(item.remarks).join('；')
      } else {
        cell.value = col.defaultValue || ''
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
      cTotal.value = { formula: `SUM(${aLet}3:${aLet}${2 + slotCount})`, result: data.grandTotal }
      cTotal.font = { name: '宋体', size: 12 }
      cTotal.alignment = CENTER_ALIGN
    }

    for (let c = 1; c <= totalCols; c++) {
      ws.getCell(r, c).border = THIN_BORDER
    }
    nextRow += 1
  }

  // ==================== 第 18~20 行：原表底部 3 行空白合并行 ====================
  const trailingBlankRows = Number.isInteger(template?.trailingBlankRows) ? template.trailingBlankRows : 3
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
  ;(template?.extraStatusFields || []).forEach((field) => {
    if (!field.label) return
    const r = nextRow
    ws.getRow(r).height = 24.95
    ws.mergeCells(r, 1, r, Math.min(12, totalCols))
    const cell = ws.getCell(r, 1)
    cell.value = `${field.label}：${field.value || ''}`
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
    data.filteredBills.forEach((b) => {
      ;(b.items || []).forEach((it) => {
        wsDetail.addRow({
          billNo: b.billNo,
          date: b.date,
          customerName: b.customerName,
          name: it.name,
          unit: it.unit || '',
          qty: Number(it.qty) || 0,
          price: Number(it.price) || 0,
          subtotal: Number(((Number(it.qty) || 0) * (Number(it.price) || 0)).toFixed(2)),
          paymentMethod: b.paymentMethod || '月结挂账',
          status: b.status === 'verified' ? '已核销' : '未核销',
          remark: b.remark || ''
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
  URL.revokeObjectURL(url)
}
