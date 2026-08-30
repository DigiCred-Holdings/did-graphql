#!/usr/bin/env node
// postinstall for @digicred-holdings/did-graphql-client.
//
// Two consumption paths need opposite things here:
//   - Installed from the npm registry (GitHub Packages): the published
//     tarball already ships a prebuilt dist/ — nothing to do, and this
//     must NOT try to build (npm doesn't install devDependencies for a
//     *nested* dependency, so a bare `tsc` postinstall crashes for a
//     real consumer — see did-graphql's own commit history).
//   - Installed as a git dependency (git+https://...): only the raw
//     source is there, dist/ doesn't exist at all, so *something* has
//     to build it. Unlike npm, Yarn Berry (this repo's own package
//     manager, and the one real git-dependency consumer today) installs
//     devDependencies for a git dependency too, so a local `tsc` is
//     actually there to run.
//
// This script tells the two cases apart at postinstall time instead of
// assuming one or the other: skip silently if dist/ is already built,
// otherwise try to build with whatever local devDependencies are
// present, and warn (without failing the install) if it can't.
'use strict'

const { existsSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const packageRoot = path.resolve(__dirname, '..')
const builtEntrypoint = path.join(packageRoot, 'dist', 'index.js')

if (existsSync(builtEntrypoint)) {
  // Registry install (or an already-built git checkout) — nothing to do.
  process.exit(0)
}

let tscBin
try {
  tscBin = require.resolve('typescript/bin/tsc', { paths: [packageRoot] })
} catch {
  tscBin = null
}

if (!tscBin) {
  console.warn(
    '[did-graphql-client] dist/ is missing and no local `typescript` devDependency was found to build it.\n' +
      '  If you installed this as a git dependency, run `npm run build` (or `yarn build`) inside\n' +
      '  node_modules/@digicred-holdings/did-graphql-client yourself, or switch to the published\n' +
      '  npm package instead, which ships dist/ prebuilt.',
  )
  process.exit(0)
}

const result = spawnSync(process.execPath, [tscBin, '-p', path.join(packageRoot, 'tsconfig.json')], {
  cwd: packageRoot,
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.warn('[did-graphql-client] build failed — see tsc output above. Continuing install anyway.')
}
process.exit(0)
