export function makeDeviceDb() {
  const rows = new Map()
  return {
    records: {
      get: async key => rows.get(key),
      put: async row => rows.set(row.key, structuredClone(row))
    },
    transaction: async (...args) => args.at(-1)()
  }
}

export const credentialFields = ['adminPin', 'adminPinHash', 'adminPinSalt', 'adminPinIsDefault']
