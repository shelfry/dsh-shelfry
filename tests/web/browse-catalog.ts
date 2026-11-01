/**
 * A local curated catalog for UI web-e2e.
 *
 * After #185 the market no longer ships a bundled snapshot: Discovery either
 * fetches the live catalog or shows loadFail. The browse lane used to claim
 * hermetic fallback in comments while still hitting the public sources, so a
 * slow or blocked CI runner sat on the loading spinner (no search box, no
 * masonry cards) until Playwright's 30s wait timed out — and the failure
 * looked like whatever PR happened to be under test.
 *
 * This server answers `plugins.json` on loopback and is pointed at through
 * `DSHM_REGISTRY_URL`, the same escape hatch the fixture install lane uses.
 * Entries are shaped for the browse assertions (pagination, search, mixed
 * script, category chips, compound card titles) without publishing anything.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Registry, RegistryPlugin } from '../../src/registry.ts'

export interface BrowseCatalogServer {
  catalogUrl: string
  close(): Promise<void>
}

/** Build the catalog the browse specs exercise. Exported for unit coverage. */
export function buildBrowseCatalog(): Registry {
  const categories: Registry['categories'] = {
    tools: { en: 'Tools', zh: '工具' },
    memory: { en: 'Memory', zh: '记忆' },
    mcp: { en: 'MCP', zh: 'MCP' },
    // Themes tab (`themePlugins`) only lists this category — without it,
    // search-sticky's Themes empty-filter case sits on「目录中暂无主题」
    // and never mounts Clear filters.
    theme: { en: 'Themes', zh: '主题' },
  }
  // Enough named chips that cats-order can expand past the two-row clip.
  for (let i = 0; i < 18; i++) {
    categories[`cat-${String(i)}`] = { en: `Category ${String(i)}`, zh: `分类${String(i)}` }
  }

  const plugins: RegistryPlugin[] = []
  const push = (plugin: RegistryPlugin): void => { plugins.push(plugin) }

  // Page size is 24; >24 tools keep the numbered pager on screen.
  for (let i = 0; i < 40; i++) {
    push({
      name: `dshm-e2e-fill-${String(i)}`,
      owner: 'dshm-e2e',
      url: `https://github.com/dshm-e2e/fill-${String(i)}`,
      category: 'tools',
      description: { en: `filler plugin ${String(i)}`, zh: `填充插件 ${String(i)}` },
      install: `dshm-e2e-fill-${String(i)}`,
      added: '2026-01-01',
      stars: 10,
    })
  }

  // Search "memory" must change the first page of the grid.
  for (let i = 0; i < 8; i++) {
    push({
      name: `dshm-e2e-memory-${String(i)}`,
      owner: 'dshm-e2e',
      url: `https://github.com/dshm-e2e/memory-${String(i)}`,
      category: 'memory',
      description: {
        en: `memory store ${String(i)}`,
        zh: `记忆存储 ${String(i)}`,
      },
      install: `dshm-e2e-memory-${String(i)}`,
      added: '2026-01-02',
      stars: 20,
    })
  }

  // Adjacent Han/Latin search ("MCP管理" ↔ "MCP 管理") needs a mixed-script hit.
  push({
    name: 'dshm-e2e-mcp-manager',
    owner: 'dshm-e2e',
    url: 'https://github.com/dshm-e2e/mcp-manager',
    category: 'mcp',
    description: { en: 'MCP manager helpers', zh: 'MCP管理 辅助' },
    install: 'dshm-e2e-mcp-manager',
    added: '2026-01-03',
    stars: 30,
  })

  for (let i = 0; i < 4; i++) {
    push({
      name: `dshm-e2e-theme-${String(i)}`,
      owner: 'dshm-e2e',
      url: `https://github.com/dshm-e2e/theme-${String(i)}`,
      category: 'theme',
      description: { en: `theme skin ${String(i)}`, zh: `主题皮肤 ${String(i)}` },
      install: `dshm-e2e-theme-${String(i)}`,
      added: '2026-01-03',
      stars: 15,
    })
  }

  // card-name.e2e walks for a compound catalog identity (`name#path`).
  push({
    name: 'OpenViking#examples/dsh-memory-plugin',
    owner: 'OpenViking',
    url: 'https://github.com/dshm-e2e/openviking',
    category: 'memory',
    description: { en: 'compound identity fixture', zh: '复合标识夹具' },
    install: 'github:dshm-e2e/openviking',
    added: '2026-01-04',
    stars: 40,
  })

  // Spare categories so the chip row overflows the collapsed clip.
  for (let i = 0; i < 18; i++) {
    push({
      name: `dshm-e2e-cat-${String(i)}`,
      owner: 'dshm-e2e',
      url: `https://github.com/dshm-e2e/cat-${String(i)}`,
      category: `cat-${String(i)}`,
      description: { en: `category ${String(i)} plugin`, zh: `分类 ${String(i)} 插件` },
      install: `dshm-e2e-cat-${String(i)}`,
      added: '2026-01-05',
      stars: 5,
    })
  }

  return {
    updated: '2026-01-01',
    count: plugins.length,
    categories,
    plugins,
  }
}

/** Serve `buildBrowseCatalog()` at `/plugins.json` on a free loopback port. */
export async function startBrowseCatalogServer(
  catalog: Registry = buildBrowseCatalog(),
): Promise<BrowseCatalogServer> {
  const body = JSON.stringify(catalog)
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/plugins.json' || url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      response.end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { done() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('browse catalog server has no port')
  }
  const catalogUrl = `http://127.0.0.1:${String(address.port)}/plugins.json`
  return {
    catalogUrl,
    close: () => new Promise<void>(done => { server.close(() => { done() }) }),
  }
}
