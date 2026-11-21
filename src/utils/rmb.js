export function numberToChineseRMB(amount) {
  const num = Number(amount)
  if (!Number.isFinite(num) || num === 0) return '零元整'

  const negative = num < 0 ? '负' : ''
  const absNum = Math.abs(num)
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const radices = ['', '拾', '佰', '仟']
  const bigRadices = ['', '万', '亿']
  const decimals = ['角', '分']

  const [intPart, decPart = ''] = absNum.toFixed(2).split('.')
  let output = ''

  if (Number(intPart) > 0) {
    let zeroCount = 0
    for (let i = 0; i < intPart.length; i++) {
      const p = intPart.length - i - 1
      const d = Number(intPart[i])
      const quotient = Math.floor(p / 4)
      const modulus = p % 4
      if (d === 0) {
        zeroCount++
      } else {
        if (zeroCount > 0) output += digits[0]
        zeroCount = 0
        output += digits[d] + radices[modulus]
      }
      if (modulus === 0 && zeroCount < 4) {
        output += bigRadices[quotient]
      }
    }
    output += '元'
  }

  let hasDec = false
  for (let i = 0; i < 2; i++) {
    const d = Number(decPart[i] || 0)
    if (d !== 0) {
      output += digits[d] + decimals[i]
      hasDec = true
    }
  }
  if (!hasDec) output += '整'
  return negative + output
}

export function formatMoney(val) {
  const n = Number(val) || 0
  return n.toFixed(2)
}

export function getMonthLastDateParts(monthStr) {
  const [y, m] = (monthStr || '2026-11').split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return {
    year: y,
    month: m,
    day: lastDay,
    dateObj: new Date(Date.UTC(y, m - 1, lastDay)),
    text: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
}
