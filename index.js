/**
 * Package entry. The bundle manifest points here; the real implementation
 * lives in `lib/` so each department keeps its own module. `Config` is the
 * schema the Host projects into its settings page.
 */
export { apply, Config, inject, name } from './lib/index.js'
