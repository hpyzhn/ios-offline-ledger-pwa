// The SDK, IndexedDB and sync-complete events are real. Playwright fulfills the
// test account's HTTP traffic in memory, including requests from the second tab.
export async function mockCloud(context) {
  const origin = 'https://settlement-fixture.dexie.cloud'
  const email = 'settlement@example.invalid'
  const userId = 'fixture-user'
  let revision = 1
  let changes = []
  await context.addInitScript(url => {
    if (location.hostname === '127.0.0.1') localStorage.setItem('offline_ledger_dexie_cloud_url', url)
  }, origin)
  await context.routeWebSocket(/settlement-fixture\.dexie\.cloud/, () => {})
  await context.route(origin + '/**', async route => {
    const request = route.request()
    const headers = {
      'access-control-allow-origin': 'http://127.0.0.1:4176',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] || 'authorization, content-type'
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const path = new URL(request.url()).pathname
    if (path === '/token') return route.fulfill({ headers, json: {
      type: 'tokens', accessToken: 'test-only', accessTokenExpiration: new Date(Date.now() + 3600000),
      claims: { sub: userId, email, name: '测试账号' }, userType: 'demo'
    } })
    if (path !== '/sync') return route.abort()
    const loggedIn = request.headers().authorization === 'Bearer test-only'
    const data = request.postDataJSON()
    const serverRevision = String(loggedIn ? revision : 0)
    return route.fulfill({ headers, json: {
      dbId: 'fixture', schema: {}, realms: loggedIn ? [userId] : [], inviteRealms: [], serverRevision,
      changes: loggedIn && data.lastPull?.serverRevision !== serverRevision ? changes : []
    } })
  })
  return {
    email,
    publish(tables) {
      revision++
      changes = Object.entries(tables).map(([table, rows]) => ({
        table, muts: [{ type: 'upsert', keys: rows.map(row => row.id),
          values: rows.map(row => ({ ...row, owner: userId, realmId: userId })) }]
      }))
    }
  }
}
