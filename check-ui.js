const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');

const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), (m) => m[1]));
const used = new Set(Array.from(js.matchAll(/\$\('([^']+)'\)/g), (m) => m[1]));
const dyn = ['pane-auto', 'pane-url', 'pane-text'];

const missing = Array.from(used).filter((i) => !ids.has(i));
const unused = Array.from(ids).filter((i) => !used.has(i) && dyn.indexOf(i) < 0);

console.log('ids used in popup.js :', used.size);
console.log('MISSING in popup.html:', missing.length ? missing : '(none)');
console.log('unused html ids      :', unused.length ? unused : '(none)');
console.log('panes               :', dyn.map((d) => d + '=' + ids.has(d)).join(', '));
console.log('tabs                :', Array.from(html.matchAll(/data-tab="([^"]+)"/g), (m) => m[1]).join(','));
