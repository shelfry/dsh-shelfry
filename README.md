<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-shelfry logo">
</p>

# dsh-shelfry

English | [中文](README.zh.md)

A plugin market for DeepSeek Harness, built by modifying
[dsh-market](https://github.com/dsh-market/dsh-market) and pointing its catalog
at **shelfry**. On dsh 0.2.1+ it is a tab on the **Plugins** page next to
**Installed**; older hosts reach it from Settings → **Shelfry Market**.
Browse, search, one-click install.

This package is **not published to npm**. Install it from the repository.

## Install

```sh
dsh plugin --profile web add github:shelfry/dsh-shelfry
```

Then restart `dsh web`. For a profile other than `web`, replace the name:

```sh
dsh plugin --profile <profile> add github:shelfry/dsh-shelfry
```

Installing from a git source makes pnpm ask before running build scripts. The
`client/client.js` bundle is committed, so the market itself needs no build
step; a prebuilt tarball can be attached to a release if you prefer that route.

On a machine with DSH Desktop, `dsh plugin --profile web` installs into
`profiles/web`, **not** the profile the desktop app uses. Install through the
app's **Settings → Plugins** instead.

## Catalog

The plugin list comes from shelfry, fetched live:

```
https://shelfry.app/data/dsh-shelfry.json
```

That file has its own shape (`entries[]` with `i`, `n`, `d`, `s`, `sc`, `t`,
`vr`, `g`, `cmd`), which is mapped onto the market's internal `Registry` in
[`src/shelfry-catalog.ts`](src/shelfry-catalog.ts). Both download regions read
the same URL — shelfry publishes one JSON, so there is no mirror to fall back to
and the market does not pretend there is.

To point it somewhere else, set `DSHM_REGISTRY_URL` in the environment dsh runs
in. Overrides replace the source list rather than heading it.

## Configuration

All settings live under `config:` in the profile's `cordis.patch.yml` — the
loader passes only that sub-object to a plugin, so a top-level key is silently
ignored:

```yaml
- id: dsh-shelfry
  name: 'dsh-shelfry'
  config:
    allowRestart: false   # hide the restart button (systemd/pm2/launchd)
    buildEnv:
      CC: /usr/bin/gcc-11
      CXX: /usr/bin/g++-11
```

- `allowRestart` — one-click restart is hidden automatically when this process
  is systemd's own service process; pm2 and launchd are not detected, so those
  deployments set this by hand.
- `buildEnv` — environment for the processes the market spawns (installs,
  compiles, git). `PATH` and `CI` stay managed by the market.
- `DSHM_GITHUB_PROXY` — operator-owned GitHub acceleration prefix; disables the
  matching field in the UI when set.

Most of the rest is edited in the UI: download region, GitHub acceleration,
release channel, entries (sidebar / Settings / Plugins tab), build environment,
favorites, groups and per-plugin notes.

## What you get

Browse and search the whole shelfry catalog with category filters, star counts
and bilingual descriptions that follow your UI language; screenshots and
comments per card; favorites; groups that switch as a unit; themes that apply
without a restart; one-click install with live progress; backup and restore
(local JSON, WebDAV, or a private GitHub Gist); per-plugin update checks with a
"What changed" link; resilient GitHub routes for the China download region;
uninstall; hot enable/disable through `cordis.patch.yml`; a one-click restart
when a change cannot hot-load; an "Adjust plugins" recovery page for a boot that
did not come back; a sanitized log export; a settings card that manages the
market itself; and a diagnostics page for load order and conflicts.

Install order: a repo-verified npm package first, then a prebuilt GitHub Release
tarball, then the full repository source. Build scripts stay blocked by default
(pnpm ≥10); allowing one is an explicit per-package choice.

## Development

```sh
npm install
npm run typecheck   # host, client, tests
npm test            # vitest, 3000+ specs
npm run build       # lib/ + client/client.js
```

`client/client.js` is a committed artifact: rebuild it and commit the result
with the source change. `scripts/preflight.mjs` (run by `prepack`) checks that
the loader id in that file matches `package.json`, that
`cordis.patch.yml` inserts by the same name, and that the declared icon ships.

The browser bundle registers itself as `window.__ModuleLoader__.load({ id })`,
where the id must equal the package name — a mismatch loads no UI at all.

See [TESTING.md](TESTING.md) for code conventions and [SECURITY.md](SECURITY.md)
for the security boundary.

## License

MIT. This is a derivative of dsh-market; the original copyright notice is
retained in [LICENSE](LICENSE).
