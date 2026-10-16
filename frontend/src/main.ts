// =============================================================================
// VELO Frontend -- Entry Point (BE-149: host preparation, then the app)
// =============================================================================
//
// Kept deliberately tiny and free of static imports of the app: anything
// imported statically here is evaluated BEFORE this module's body runs, and
// platform/index.ts picks Telegram vs standalone at evaluation time. So:
//
//   1. installHostChunkReload() -- first, so even a failed load of the app
//      module below gets its one silent reload (platform/chunk-reload.ts);
//   2. prepareHost()            -- Telegram launch: load telegram-web-app.js
//      and wait; otherwise: no telegram.org, viewport-fit=cover
//      (platform/launch.ts);
//   3. import('./app')          -- the application itself (app.ts).
// =============================================================================

import { installHostChunkReload } from './platform/chunk-reload'
import { prepareHost } from './platform/launch'

installHostChunkReload()
await prepareHost()
await import('./app')
