// 统计 app.js 里用到、但 styles.css 里没有定义的 class
// 用法: node class-cov.cjs <app.js> <styles.css>
const fs = require('fs');
const app = fs.readFileSync(process.argv[2], 'utf8');
const css = fs.readFileSync(process.argv[3], 'utf8');

const used = new Set();
for (const m of app.matchAll(/class="([^"]*)"/g)) {
  const raw = m[1].replace(/\$\{[^}]*\}/g, ' ');
  for (const t of raw.split(/\s+/)) if (/^[a-z][\w-]*$/.test(t)) used.add(t);
}
const defined = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);
const missing = [...used].filter((c) => !defined.has(c)).sort();
console.log('used', used.size, 'missing', missing.length);
if (missing.length) console.log(missing.join(' '));
process.exit(missing.length ? 1 : 0);
