// Copia in src/vendor/three/ i soli file di three.js necessari, cosi' il progetto
// funziona senza node_modules (che resta fuori dal repository).
// Uso:  npm install && npm run vendor
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'three');
const dst = join(root, 'src', 'vendor', 'three');
const files = [
  ['build/three.module.min.js', 'three.module.min.js'],
  ['LICENSE', 'LICENSE'],
  ['examples/jsm/environments/RoomEnvironment.js', 'addons/environments/RoomEnvironment.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
];
for (const [from, to] of files) {
  const out = join(dst, to);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(join(src, from), out);
  console.log('vendor:', to);
}
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
writeFileSync(join(dst, 'VERSION'), version + '\n');
console.log('three.js', version);
