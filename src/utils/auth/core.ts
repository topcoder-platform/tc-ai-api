import { createRequire } from 'node:module';
import type * as Core from 'tc-core-library-js';
const require = createRequire(import.meta.url);
/** Typed CommonJS bridge; all auth decisions delegate to the pinned shared core. */
export const core = require('tc-core-library-js') as typeof Core;
