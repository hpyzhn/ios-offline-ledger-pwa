import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/db/database.js', import.meta.url), 'utf8')
const recovery = source.slice(source.indexOf('export function cloudNeedsVerification'), source.indexOf('export const DEFAULT_PRODUCTS'))
  .replace(/^export /gm, '')

test('first account sync retries on the same database, then manual sync pulls', async () => {
  const userId = 'test-user'
  let state = { initiallySynced: true, realms: [] }
  let closeCount = 0
  let openCount = 0
  let pullCount = 0
  const db = {
    close() { closeCount++ },
    async open() { openCount++; state = { initiallySynced: true, realms: [userId] } },
    table: () => ({ get: async () => state }),
    cloud: {
      currentUser: { value: { isLoggedIn: true, userId } },
      syncState: { value: { phase: 'error' } },
      async sync({ purpose, wait }) { assert.equal(purpose, 'pull'); assert.equal(wait, true); pullCount++ }
    }
  }
  const app = vm.createContext({ db, setTimeout, clearTimeout })
  vm.runInContext(recovery, app)
  await app.syncCloudLedger()
  assert.equal(closeCount, 1)
  assert.equal(openCount, 1)
  assert.equal(pullCount, 0)
  await app.syncCloudLedger()
  assert.equal(pullCount, 1)
  assert.equal(openCount, 1)
})

test('expired or rejected refresh token requires verification but an outage does not', () => {
  const app = vm.createContext({})
  vm.runInContext(recovery, app)
  const user = { isLoggedIn: true, accessTokenExpiration: new Date(0), refreshToken: 'test', refreshTokenExpiration: new Date(0) }
  assert.equal(app.cloudNeedsVerification(user), true)
  assert.equal(app.cloudNeedsVerification({ isLoggedIn: true }, new Error('HTTP 401')), true)
  assert.equal(app.cloudNeedsVerification({ isLoggedIn: true }, new Error('HTTP 503')), false)
})
