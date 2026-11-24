import { billTotal } from './money.js'

/**
 * 仿美团/淘宝/京东快递智能文本识别器
 * 支持一次性粘贴多个客户的报数信息，自动解析客户、日期、类目、数量、单价、核销状态与备注
 */

function pad2(n) {
  return String(n).padStart(2, '0')
}

function getOffsetDateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function extractDate(text) {
  let cleaned = text
  let dateStr = getOffsetDateStr(0)

  // 1. YYYY-MM-DD 或 YYYY/MM/DD 或 YYYY.MM.DD
  const fullMatch = cleaned.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/)
  if (fullMatch) {
    dateStr = `${fullMatch[1]}-${pad2(fullMatch[2])}-${pad2(fullMatch[3])}`
    cleaned = cleaned.replace(fullMatch[0], ' ')
    return { dateStr, cleaned }
  }

  // 2. MM月DD日 或 MM-DD 或 MM/DD
  const shortMatch = cleaned.match(/(?:^|[\s,，;；:])(\d{1,2})[月/-](\d{1,2})日?(?=$|[\s,，;；:])/)
  if (shortMatch) {
    const y = new Date().getFullYear()
    dateStr = `${y}-${pad2(shortMatch[1])}-${pad2(shortMatch[2])}`
    cleaned = cleaned.replace(shortMatch[0], ' ')
    return { dateStr, cleaned }
  }

  // 3. 今天 / 昨天 / 前天
  if (/昨天/.test(cleaned)) {
    dateStr = getOffsetDateStr(-1)
    cleaned = cleaned.replace(/昨天/g, ' ')
  } else if (/前天/.test(cleaned)) {
    dateStr = getOffsetDateStr(-2)
    cleaned = cleaned.replace(/前天/g, ' ')
  } else if (/今天/.test(cleaned)) {
    dateStr = getOffsetDateStr(0)
    cleaned = cleaned.replace(/今天/g, ' ')
  }

  return { dateStr, cleaned }
}

function lookupPriceAndUnit(itemName, customerObj, globalProducts) {
  if (customerObj?.categories?.length) {
    const found = customerObj.categories.find((c) => c.name === itemName)
    if (found) return { price: Number(found.price) || 0, unit: found.unit || '条' }
  }
  if (globalProducts?.length) {
    const found = globalProducts.find((p) => p.name === itemName)
    if (found) return { price: Number(found.defaultPrice) || 0, unit: found.unit || '条' }
  }
  return { price: 1.0, unit: '条' }
}

/**
 * 解析单条记录（可能来自单行，也可能来自 ---/空行 分隔的多行块）
 */
function parseOneRecord(blockText, existingCustomers, globalProducts) {
  let work = blockText.replace(/[\r]+/g, '\n').trim()
  if (!work) return null

  // 合并多行成易解析的令牌流，同时优先抽取带显式标签的字段
  let customerName = ''
  let remark = ''
  let status = 'pending'
  let paymentMethod = '月结挂账'

  // 抽取显式备注：备注:xxx 或 车号:xxx
  const remarkMatch = work.match(/(?:备注|车号|说明)[：: ]\s*([^\n]+)/)
  if (remarkMatch) {
    remark = remarkMatch[1].trim()
    work = work.replace(remarkMatch[0], ' ')
  }

  // 抽取显式客户标签：客户:xxx / 商家:xxx / 酒店:xxx
  const custLabelMatch = work.match(/(?:客户|商家|门店|单位)[：:]\s*([^\s,，;；\n]+)/)
  if (custLabelMatch) {
    customerName = custLabelMatch[1].trim()
    work = work.replace(custLabelMatch[0], ' ')
  }

  // 抽取日期标签与日期值
  work = work.replace(/(?:日期|时间)[：:]/g, ' ')
  const { dateStr, cleaned } = extractDate(work)
  work = cleaned

  // 抽取核销状态与收款方式关键词
  if (/已核销|已结清|已付款/.test(work)) {
    status = 'verified'
    work = work.replace(/已核销|已结清|已付款/g, ' ')
  } else if (/未核销|待核销/.test(work)) {
    status = 'pending'
    work = work.replace(/未核销|待核销/g, ' ')
  }

  for (const pm of ['微信', '支付宝', '银行转账', '现金', '月结挂账']) {
    if (work.includes(pm)) {
      paymentMethod = pm
      work = work.replace(pm, ' ')
      break
    }
  }

  // 切分成片段（空格、逗号、顿号、分号、换行）
  const tokens = work
    .split(/[\s,，、;；\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  if (tokens.length === 0) return null

  // 如果前面没有显式“客户:”标签，且第一个片段不含数字（不是“台布125”），则默认第一个片段是客户名
  let startIdx = 0
  if (!customerName) {
    const first = tokens[0]
    if (!/[\d]/.test(first)) {
      customerName = first.replace(/[：:]$/, '')
      startIdx = 1
    } else {
      // 尝试匹配已有客户名前缀
      const matchedCust = (existingCustomers || []).find((c) => first.startsWith(c.name))
      if (matchedCust) {
        customerName = matchedCust.name
        tokens[0] = first.slice(matchedCust.name.length)
      }
    }
  }

  if (!customerName) customerName = '未命名客户'

  const existingCust = (existingCustomers || []).find((c) => c.name === customerName) || null

  // 解析类目 + 数量 + 可选单价（支持：台布125 / 台布:125 / 台布 125 / 台布125*1.5 / 台布125@1.5 / 台布125条）
  const items = []
  let i = startIdx
  while (i < tokens.length) {
    const tk = tokens[i]
    if (!tk) {
      i++
      continue
    }

    // 情况 A：同一词里包含 类目名 + 数量 (+ 可选单价)，如 "台布125"、"大台布:2*1.8"、"椅套7个"
    const mInline = tk.match(/^([^\d:：*×@]+?)[：:=]?(\d+(?:\.\d+)?)(?:[条个幅件套张斤吨])?(?:[*×@￥¥](\d+(?:\.\d+)?))?$/)
    if (mInline) {
      const name = mInline[1].trim()
      const qty = Number(mInline[2])
      const explicitPrice = mInline[3] !== undefined ? Number(mInline[3]) : null
      const def = lookupPriceAndUnit(name, existingCust, globalProducts)
      items.push({
        name,
        qty,
        price: explicitPrice !== null ? explicitPrice : def.price,
        unit: def.unit
      })
      i++
      continue
    }

    // 情况 B：类目名和数字被空格隔开，如 "台布" "125"
    if (i + 1 < tokens.length) {
      const mNext = tokens[i + 1].match(/^(\d+(?:\.\d+)?)(?:[条个幅件套张斤吨])?(?:[*×@￥¥](\d+(?:\.\d+)?))?$/)
      if (mNext && !/\d/.test(tk)) {
        const name = tk.replace(/[：:=]$/, '').trim()
        const qty = Number(mNext[1])
        const explicitPrice = mNext[2] !== undefined ? Number(mNext[2]) : null
        const def = lookupPriceAndUnit(name, existingCust, globalProducts)
        items.push({
          name,
          qty,
          price: explicitPrice !== null ? explicitPrice : def.price,
          unit: def.unit
        })
        i += 2
        continue
      }
    }

    i++
  }

  if (items.length === 0) return null

  const totalAmount = billTotal(items)

  return {
    id: 'preview_' + Math.random().toString(36).slice(2, 9),
    selected: true,
    isNewCustomer: !existingCust,
    customerName,
    date: dateStr,
    month: dateStr.slice(0, 7),
    status,
    paymentMethod,
    remark,
    items,
    totalAmount
  }
}

/**
 * 批量解析入口：自动判断是“按行多客户”还是“按 --- / 空行 分段多客户”
 */
export function parseSmartBatchText(rawText, existingCustomers = [], globalProducts = []) {
  const text = (rawText || '').trim()
  if (!text) return []

  // 若包含 --- 分隔符或显式“客户：”多行块，按块拆；否则按每一行拆
  let blocks = []
  if (/^-{3,}$/m.test(text) || /客户[：:]/.test(text)) {
    blocks = text
      .split(/(?:^-{3,}$|\n\s*\n)/m)
      .map((b) => b.trim())
      .filter(Boolean)
  } else {
    blocks = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  const results = []
  blocks.forEach((blk) => {
    const rec = parseOneRecord(blk, existingCustomers, globalProducts)
    if (rec) results.push(rec)
  })
  return results
}

export const SMART_IMPORT_EXAMPLE = `留香东江酒店 2026-11-21 台布125 大台布2 椅套7 台裙6 席巾50
餐厅A 11月21日 台布30 椅套15 备注：午市加急
金满楼酒店 今天 台布80 席巾100 红台布10*1.2 已核销`
