import { describe, expect, it } from 'vitest'
import { buildBrowseCatalog, startBrowseCatalogServer } from './browse-catalog.ts'

describe('browse catalog for UI web-e2e', () => {
  it('covers pagination, search, mixed-script, compound identity, and many chips', () => {
    const catalog = buildBrowseCatalog()
    expect(catalog.plugins.length).toBeGreaterThan(24)
    expect(catalog.plugins.some(plugin => /memory/i.test(plugin.name) || /memory/i.test(plugin.description.en))).toBe(true)
    expect(catalog.plugins.some(plugin => /MCP管理/.test(plugin.description.zh))).toBe(true)
    expect(catalog.plugins.some(plugin => plugin.name.includes('#'))).toBe(true)
    expect(catalog.plugins.some(plugin => plugin.category === 'theme')).toBe(true)
    expect(Object.keys(catalog.categories).length).toBeGreaterThan(10)
  })

  it('serves plugins.json on loopback for DSHM_REGISTRY_URL', async () => {
    const server = await startBrowseCatalogServer()
    try {
      const response = await fetch(server.catalogUrl)
      expect(response.ok).toBe(true)
      const body = await response.json() as { plugins: unknown[] }
      expect(body.plugins.length).toBeGreaterThan(24)
    } finally {
      await server.close()
    }
  })
})
