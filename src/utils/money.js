export function billTotal(items) {
  return Number(items.reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0).toFixed(2))
}

// 分配账单尾差，保证各类目合计与已保存的账单金额一致。
export function allocateBillCents(items, total = billTotal(items)) {
  const cents = items.map(item => Number(item.qty) * Number(item.price) * 100)
  if (!cents.length) return []
  const amounts = cents.map(Math.floor)
  const order = cents.map((value, index) => ({ index, remainder: value - amounts[index] }))
    .sort((a, b) => b.remainder - a.remainder)
  const difference = Math.round(total * 100) - amounts.reduce((sum, value) => sum + value, 0)
  const share = Math.trunc(difference / amounts.length)
  const remainder = difference % amounts.length
  order.forEach(({ index }, rank) => {
    amounts[index] += share + (rank < Math.abs(remainder) ? Math.sign(remainder) : 0)
  })
  return amounts
}
