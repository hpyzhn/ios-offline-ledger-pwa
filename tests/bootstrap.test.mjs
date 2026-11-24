import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const bootstrap = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')

async function start(cloudConfigured, persistedState) {
  let seeded = false
  let mounted = false
  const root = { append(_, link) { this.link = link } }
  await vm.runInNewContext(bootstrap, {
    cloudConfigured, navigator: {}, console: { error() {} },
    document: { getElementById: () => root, createElement: () => ({}) },
    db: {
      open: async () => {},
      table(name) {
        assert.equal(name, '$syncState')
        return { get: async () => persistedState }
      },
      cloud: { syncState: { value: { error: new Error('404 Not Found') } } }
    },
    seedInitialData: async () => { seeded = true },
    App: {}, createApp: () => ({ mount() { mounted = true } })
  })
  return { seeded, mounted, root }
}

test('failed first cloud sync allows recovery without writing seeds', async () => {
  const { seeded, mounted, root } = await start(true, undefined)
  assert.equal(seeded, false)
  assert.equal(mounted, false)
  assert.match(root.textContent, /首次云同步未完成.*404/)
  assert.equal(root.link.href, '?ledger=local')
})

test('local ledger and previously synced ledger can start during a sync outage', async () => {
  for (const args of [[false, undefined], [true, { initiallySynced: true }]]) {
    const { mounted, seeded } = await start(...args)
    assert.ok(mounted && seeded)
  }
})
