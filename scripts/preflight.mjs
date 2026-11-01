#!/usr/bin/env node
/**
 * Pre-pack guard: every place that must carry the npm package name actually
 * does. Both 1.0.0 (bundle patch name) and 1.0.1 (client loader id) shipped
 * broken after the dsh-market → dshmarket rename because these are plain
 * strings no compiler checks.
 *
 * Also keeps the Plugins-page artwork contract intact: DSH ≥ 0.1.7 reads
 * top-level package.json.icon and a missing or unpackaged file turns into a
 * meta.error on the installed row rather than a quiet placeholder.
 */
import fs from 'node:fs'
import path from 'node:path'

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const name = manifest.name

const failures = []

const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes(`name: '${name}'`)) {
  failures.push(`cordis.patch.yml must insert by package name '${name}'`)
}

const client = fs.readFileSync('client/client.js', 'utf8')
if (!client.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}`)) {
  failures.push(`client/client.js must register __ModuleLoader__ id ${JSON.stringify(name)}`)
}

/** Max bytes the host accepts for package.json.icon (DSH Plugins page). */
const ICON_MAX_BYTES = 256 * 1024
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])

const icon = manifest.icon
if (typeof icon !== 'string' || icon.trim() === '') {
  failures.push('package.json must declare a top-level "icon" path for the Plugins page')
} else if (path.isAbsolute(icon) || /^[A-Za-z]:[\\/]/.test(icon) || /^(?:https?:)?\/\//i.test(icon)) {
  failures.push(`package.json.icon must be a relative path inside the package (got ${JSON.stringify(icon)})`)
} else {
  const resolved = path.resolve(icon)
  const root = path.resolve('.')
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    failures.push(`package.json.icon escapes the package root (got ${JSON.stringify(icon)})`)
  } else if (!ICON_EXTENSIONS.has(path.extname(icon).toLowerCase())) {
    failures.push(`package.json.icon must be .svg/.png/.jpg/.jpeg/.webp (got ${JSON.stringify(icon)})`)
  } else if (!fs.existsSync(resolved)) {
    failures.push(`package.json.icon file missing: ${icon}`)
  } else {
    const size = fs.statSync(resolved).size
    if (size > ICON_MAX_BYTES) {
      failures.push(`package.json.icon is ${size} bytes; host limit is ${ICON_MAX_BYTES}`)
    }
    const shipped = Array.isArray(manifest.files) && manifest.files.some((entry) => {
      if (typeof entry !== 'string' || entry === '') return false
      const normalized = entry.replace(/\\/g, '/')
      const target = icon.replace(/\\/g, '/')
      return target === normalized || target.startsWith(normalized.replace(/\/?$/, '/'))
    })
    if (!shipped) {
      failures.push(`package.json.files must include ${JSON.stringify(icon)} (or a parent directory) so the Plugins page can load it`)
    }
  }
}

/**
 * A lockfile resolving to a mirror publishes fine and then fails in the
 * consumer's install with EALLOWREMOTE, because a full tarball URL is not a
 * registry name they can re-resolve. It reached us twice — 1.12.0 shipped
 * with 61 npmmirror URLs and had its tag deleted and re-cut, then a single
 * one came back the next time a lock was refreshed behind a mirror. Nothing
 * about running `npm install` in China makes this visible locally, so the
 * guard belongs where the package is built rather than in anyone's habits.
 */
const lock = fs.readFileSync('package-lock.json', 'utf8')
const foreign = [...new Set(
  [...lock.matchAll(/"resolved": "(https?:\/\/[^/"]+)/g)]
    .map(match => match[1])
    .filter(host => host !== 'https://registry.npmjs.org'),
)]
if (foreign.length > 0) {
  failures.push(`package-lock.json resolves to ${foreign.join(', ')} — rewrite to https://registry.npmjs.org or consumers hit EALLOWREMOTE`)
}

if (failures.length > 0) {
  console.error('preflight failed:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log(`preflight ok: ${name}`)
