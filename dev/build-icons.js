// Renders the toolbar and extension icons from dev/icon/*.svg into icons/*.png
// with headless Chrome (macOS path; pass another Chrome binary as argument).
//
//   node dev/build-icons.js [path/to/chrome]
//
// 16 and 32 px use icon-small.svg (larger sign, thicker lines), 48 and 128 px icon.svg.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chrome = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.join(__dirname, '..');
const sizes = { 16: 'icon-small.svg', 32: 'icon-small.svg', 48: 'icon.svg', 128: 'icon.svg' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-icons-'));
fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const [size, file] of Object.entries(sizes)) {
  const svg = fs.readFileSync(path.join(__dirname, 'icon', file), 'utf8');
  const page = path.join(tmp, `${size}.html`);
  fs.writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const out = path.join(root, 'icons', `icon${size}.png`);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${size},${size}`,
    '--default-background-color=00000000', `--screenshot=${out}`, `file://${page}`], { stdio: 'ignore' });
  console.log(out);
}
fs.rmSync(tmp, { recursive: true, force: true });
