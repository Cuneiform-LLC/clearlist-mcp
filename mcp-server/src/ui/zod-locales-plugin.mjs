/**
 * esbuild plugin: bundle zod's English error messages only.
 *
 * zod re-exports every translation as a namespace (`export * as locales from
 * "../locales/index.js"` in classic/external, mini/external and core/index),
 * and esbuild cannot tree-shake a namespace re-export. So the widget carried
 * ~60 language files (~265KB of a ~555KB bundle at zod 4.6.5) that nothing
 * reads. The classic API registers `en` on its own: classic/schemas.js imports
 * `../locales/en.js` directly and applies it on the first schema construction.
 * No view or dependency switches locale.
 *
 * The widget reaches zod transitively (views/shared.ts -> ext-apps -> the MCP
 * sdk -> zod); nothing in src/ui imports it directly.
 *
 * Only the locales INDEX is replaced, and only when imported from inside
 * zod/v4/. The direct `en.js` import above never goes through the index, so
 * English messages are unchanged. The build does NOT catch a future `z.locales.<other>()` call:
 * esbuild bundles it without a warning and it throws "is not a function" at
 * runtime. Checked by hand at zod 4.6.5; if a view ever needs another
 * language, drop this plugin rather than widening the stub.
 */
import { dirname, join } from 'node:path'

const LOCALES_INDEX = /^\.\.\/locales\/index\.js$/
const NAMESPACE = 'zod-english-only'

export const zodEnglishOnly = {
  name: 'zod-english-only',
  setup(build) {
    build.onResolve({ filter: LOCALES_INDEX }, (args) => {
      const importer = args.importer.replace(/\\/g, '/')
      if (!/\/node_modules\/zod\/v4\//.test(importer)) return undefined
      return {
        path: join(dirname(args.importer), '..', 'locales', 'en.js'),
        namespace: NAMESPACE,
      }
    })
    build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(args.path)}`,
      resolveDir: dirname(args.path),
      loader: 'js',
    }))
  },
}
