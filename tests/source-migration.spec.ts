import { describe, expect, it } from 'vitest'
          import { declaredPredecessors, findCatalogRename, findGitToNpmMigration, findNpmTargetEntry, isRegistryRangeSpec, sameLoaderRows } from '../src/source-migration.ts'

          const plugins = [
            { name: 'dsh-genui', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@changfenhuang/dsh-genui' },
            { name: 'mono#a', url: 'https://github.com/o/mono/tree/main/packages/a', npm: '@o/a' },
            { name: 'mono#b', url: 'https://github.com/o/mono/tree/main/packages/b', npm: '@o/b' },
          ]

          describe('findGitToNpmMigration', () => {
            it('matches only the exact verified repository identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui')).toEqual({
                kind: 'git-to-npm',
                repo: 'omdsh-dev/dsh-genui',
                target: '@changfenhuang/dsh-genui',
              })
              expect(findGitToNpmMigration(plugins, 'github:someone-else/dsh-genui')).toBeNull()
            })

            it('keeps explicit branch, tag, commit and semver selections on Git', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#publish')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#v1.0.0')).toBeNull()
              expect(findGitToNpmMigration(plugins, `github:omdsh-dev/dsh-genui#${'a'.repeat(40)}`)).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#semver:^1.0.0')).toBeNull()
            })

            it('requires exact monorepo path identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:o/mono')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/a')).toEqual({
                kind: 'git-to-npm',
                repo: 'o/mono#path:/packages/a',
                target: '@o/a',
              })
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/missing')).toBeNull()
            })

            it('fails closed when one identity maps to multiple verified npm entries', () => {
              const ambiguous = [
                ...plugins,
                { name: 'duplicate', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@other/dsh-genui' },
              ]
              expect(findGitToNpmMigration(ambiguous, 'github:omdsh-dev/dsh-genui')).toBeNull()
            })
          })

          /**
           * #1012. The rename target is reported by an update failure, but the
           * route body is user-reachable, so the entry that publishes it must
           * exist in the catalog before a profile is pointed at it.
           */
          describe('findNpmTargetEntry', () => {
            it('returns the single catalog entry that publishes the name on npm', () => {
              expect(findNpmTargetEntry(plugins, '@o/a')?.name).toBe('mono#a')
              expect(findNpmTargetEntry(plugins, '@changfenhuang/dsh-genui')?.name).toBe('dsh-genui')
            })

            it('does not pick a target the catalog never published on npm', () => {
              expect(findNpmTargetEntry(plugins, 'dsh-evo-subagent')).toBeNull()
              expect(findNpmTargetEntry(plugins, '@nobody/missing')).toBeNull()
              expect(findNpmTargetEntry([{ name: 'git-only', url: 'https://github.com/o/x' }], '@o/x')).toBeNull()
            })

            it('fails closed when two entries claim one npm name', () => {
              const duplicates = [
                ...plugins,
                { name: 'other', url: 'https://github.com/o/other', npm: '@o/a' },
              ]
              expect(findNpmTargetEntry(duplicates, '@o/a')).toBeNull()
            })

            it('ignores entries whose npm field is not a package name', () => {
              expect(findNpmTargetEntry([{ name: 'x', npm: 'not a name' }], 'not a name')).toBeNull()
            })
          })

          describe('findCatalogRename (#1012 P1)', () => {
            const catalog = [
              { name: 'evo-subagent', npm: 'dsh-evo-subagent', previousNpm: ['evo-subagent-old'] },
              { name: 'renamed', npm: '@scope/renamed', previousNpm: ['@scope/legacy'] },
              { name: 'plain', npm: 'plain' },
            ]

            it('finds the entry that declares the installed name as its predecessor', () => {
              expect(findCatalogRename(catalog, 'evo-subagent-old')).toEqual({
                entry: catalog[0],
                target: 'dsh-evo-subagent',
              })
              // npm names are case-insensitive, and the installed key may differ in case
              expect(findCatalogRename(catalog, '@SCOPE/Legacy')?.target).toBe('@scope/renamed')
            })

            it('offers nothing when no entry claims the name', () => {
              expect(findCatalogRename(catalog, 'evo-subagent')).toBeNull()
              expect(findCatalogRename(catalog, 'plain')).toBeNull()
            })

            it('fails closed when two entries claim one former name', () => {
              const ambiguous = [
                ...catalog,
                { name: 'impostor', npm: 'impostor', previousNpm: ['evo-subagent-old'] },
              ]
              expect(findCatalogRename(ambiguous, 'evo-subagent-old')).toBeNull()
            })

            it('requires the successor to be installable from npm', () => {
              expect(findCatalogRename([{ name: 'git-only', previousNpm: ['old'] }], 'old')).toBeNull()
              expect(findCatalogRename([{ name: 'self', npm: 'self', previousNpm: ['self'] }], 'self')).toBeNull()
            })
          })

          describe('declaredPredecessors (#1012)', () => {
            const entry = { name: 'evo', npm: 'dsh-evo-subagent', previousNpm: ['evo-subagent-old', 'evo-subagent-older'] }

            it('lists every declared former name that is installed, as written in the profile', () => {
              const installed = { 'evo-subagent-old': '^1.1.0', 'EVO-SUBAGENT-OLDER': '^1.0.0', other: '^1.0.0' }
              expect(declaredPredecessors(entry, installed)).toEqual(['evo-subagent-old', 'EVO-SUBAGENT-OLDER'])
            })

            it('is silent without a declaration or without a match', () => {
              expect(declaredPredecessors({ name: 'x', npm: 'x' }, { anything: '^1.0.0' })).toEqual([])
              expect(declaredPredecessors(entry, { other: '^1.0.0' })).toEqual([])
            })
          })

          describe('isRegistryRangeSpec (#1012)', () => {
            it('accepts plain version ranges and tags', () => {
              for (const spec of ['1.2.3', '^1.2.3', '~1.2', 'latest', '>=1 <2']) {
                expect(isRegistryRangeSpec(spec)).toBe(true)
              }
            })

            it('refuses git, path, alias and workspace sources', () => {
              for (const spec of ['github:o/r', 'git+https://github.com/o/r.git', 'file:../x', 'link:../x', 'workspace:*', 'npm:dsh-genui@1.2.3', 'a/b', '../plugin', '']) {
                expect(isRegistryRangeSpec(spec)).toBe(false)
              }
            })
          })

          describe('sameLoaderRows (#1012)', () => {
            it('proves sameness from one shared row, in either direction', () => {
              expect(sameLoaderRows(['a', 'b'], ['b', 'c'])).toBe(true)
              expect(sameLoaderRows(['b'], ['b'])).toBe(true)
            })

            it('refuses to call disjoint rows the same plugin', () => {
              expect(sameLoaderRows(['a'], ['b'])).toBe(false)
            })

            it('proves nothing from a missing side', () => {
              expect(sameLoaderRows([], ['b'])).toBe(false)
              expect(sameLoaderRows(['a'], [])).toBe(false)
            })
          })

