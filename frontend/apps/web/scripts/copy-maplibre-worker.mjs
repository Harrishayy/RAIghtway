// MapLibre 6 runs its tile parsing in a module worker. Bundlers can't see that file, so we serve the
// worker (and the chunk it imports) from /public and point MapLibre at it with setWorkerUrl().
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')) + '/dist';
const out = join(here, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(join(dist, f), join(out, f));
console.log('maplibre worker → public/maplibre');
