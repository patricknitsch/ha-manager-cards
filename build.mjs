// Baut dist/ha-manager-cards.js aus allen Karten in src/.
// Jede Datei kommt in einen eigenen Block, damit sich gleichnamige Konstanten nicht stören.
// Aufruf: node build.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
// Reihenfolge: Manager Cards zuerst, dann die Karten, die sie verwenden
const LAST = ['area-overview-card.js', 'home-dashboard-card.js'];
const FIRST = ['00-activity.js']; // gemeinsame Aktivitätserkennung vor allen Karten
const files = readdirSync(new URL('./src/', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .sort((a, b) => (FIRST.includes(b) - FIRST.includes(a)) || (LAST.indexOf(a) - LAST.indexOf(b)) || a.localeCompare(b));

let out = `/*! HA Manager Cards ${pkg.version} – ${files.filter((f) => !FIRST.includes(f)).length} Karten: ${files.filter((f) => !FIRST.includes(f)).map((f) => f.replace(/\.js$/, '')).join(', ')} */\n`;
for (const f of files) {
  const src = readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
  out += `\n/* ===== ${f} ===== */\n{\n${src}\n}\n`;
}
out += `\nconsole.info('%c HA-MANAGER-CARDS %c ${pkg.version} ', 'background:#03a9f4;color:#fff', 'background:#eee;color:#333');\n`;
writeFileSync(new URL('./dist/ha-manager-cards.js', import.meta.url), out);
console.log(`dist/ha-manager-cards.js: ${files.length - FIRST.length} Karten, ${(out.length / 1024).toFixed(1)} KB`);
