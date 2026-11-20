// Uso: node test/shot.js <archivo.dwf> <salida-prefijo> [hoja] [w] [h] [evalJS]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const [file, out, sheet = '0', w = '1400', h = '900', extra = ''] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../dist/VisorDWF.html'));
  if (file !== '-') {
    await page.setInputFiles('#file', file);
    await page.waitForFunction(() => document.body.classList.contains('has-doc') || !document.getElementById('error').hidden, null, { timeout: 20000 });
    if (+sheet) await page.evaluate(i => window.VisorDWF.showSheet(i), +sheet);
    if (extra) await page.evaluate(extra);
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => ({ ms: window.VisorDWF.state.lastDrawMs, notice: document.getElementById('notice').hidden ? '' : document.getElementById('noticeText').textContent, error: document.getElementById('error').hidden ? '' : document.getElementById('errorText').textContent, zoom: document.getElementById('zoomLabel').textContent, info: document.getElementById('sheetInfo').textContent }));
    console.log(JSON.stringify(info));
  }
  await page.screenshot({ path: out });
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
})();
