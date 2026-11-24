// 只接受业务字段，云库归属和同步元数据由目的库设置。
function publicRow(row) {
  const { owner, realmId, _hasBlobRefs, $ts, ...data } = row
  return data
}

function collect(table, incoming, existing, valueKey) {
  const ids = new Map(existing.filter(row => row.id != null).map(row => [row.id, row]))
  const keys = new Map(existing.map(row => [valueKey(row), row]))
  const rows = []
  const links = new Map()
  for (const row of incoming || []) {
    const data = publicRow(row)
    delete data.restoreWithoutBillNo
    const key = valueKey(row)
    let accepted = ids.get(data.id) || keys.get(key)
    if (!accepted) {
      const prefix = table.idPrefix?.()
      if (prefix && !(typeof data.id === 'string' && (data.id.startsWith(prefix) || data.id.startsWith('#' + prefix)))) {
        data.id = table.newId({ colocateWith: table.db.cloud.currentUserId })
      }
      accepted = data
      rows.push(data)
      keys.set(key, data)
      if (data.id != null) ids.set(data.id, data)
    }
    if (row.id != null) links.set(row.id, accepted.id)
    if (row.id != null) ids.set(row.id, accepted)
  }
  return { rows, links }
}

export async function planLedgerMerge(db, data) {
  const [bills, customers, products, logs] = await Promise.all([
    db.bills.toArray(), db.customers.toArray(), db.products.toArray(), db.auditLogs.toArray()
  ])
  const billKey = row => {
    if (row.billNo && !row.restoreWithoutBillNo && !/^NO\.\d{8}-R\d+-\d+$/.test(row.billNo)) return row.billNo
    return JSON.stringify([row.date, row.customerName, row.items, row.remark || ''])
  }
  const billPlan = collect(db.bills, data.bills, bills, billKey)
  const name = row => row.name.trim()
  const auditKey = row => JSON.stringify([row.billNo, row.createdAt, row.reason])
  const importedLogs = (data.auditLogs || []).map(log => ({
    ...log, billId: billPlan.links.get(log.billId) || log.billId
  }))
  return {
    bills: billPlan.rows,
    customers: collect(db.customers, data.customers, customers, name).rows,
    products: collect(db.products, data.products, products, name).rows,
    auditLogs: collect(db.auditLogs, importedLogs, logs, auditKey).rows
  }
}

export async function createLedgerBackup(db, settings) {
  const [customers, products, bills, auditLogs, profile] = await db.transaction(
    'r', db.customers, db.products, db.bills, db.auditLogs, db.settings,
    () => Promise.all([
      db.customers.toArray(), db.products.toArray(), db.bills.toArray(), db.auditLogs.toArray(), settings()
    ])
  )
  return {
    version: 3, exportedAt: new Date().toISOString(),
    customers: customers.map(publicRow), products: products.map(publicRow),
    bills: bills.map(publicRow), auditLogs: auditLogs.map(publicRow),
    settings: { companyName: profile.companyName, handlerName: profile.handlerName }
  }
}
