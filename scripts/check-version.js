// Comprueba que los ejemplos del README fijen la versión de package.json (npm run check).
// No va en el paquete: solo lo usan el repo y la CI.

import { readFileSync } from 'node:fs';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const errors = [];

// Cada uso en un comando o en un JSON de configuración: `npx … <name>[@versión]` o `"<name>[@versión]"`.
for (const [line, i] of readme.split('\n').map((l, n) => [l, n + 1])) {
  if (!/\bnpx\b|"/.test(line) || line.startsWith('#')) continue;
  // (?<!/): no dentro de una URL, como la imagen de unpkg, que debe seguir a la última versión.
  for (const m of line.matchAll(new RegExp(`(?<!/)${escaped}(@[\\w.-]+)?`, 'g'))) {
    if (m[1] !== `@${version}`) errors.push(`README.md:${i}: ${m[0]} (expected ${name}@${version})`);
  }
}

if (errors.length) {
  console.error(`Pinned versions in the README don't match package.json ${version}:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
