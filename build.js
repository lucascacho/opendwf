#!/usr/bin/env node
// Genera dist/VisorDWF.html: un único archivo autocontenido que se abre con doble clic.
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');

const tables = JSON.stringify(JSON.parse(src('tables.json')));
const core = src('dwf-core.js').replace('/*__TABLES__*/ null', () => tables);
if (!core.includes(tables.slice(0, 40))) throw new Error('No se pudieron inyectar las tablas');

const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const html = src('index.html')
  .replace('/*__CSS__*/', () => src('style.css'))
  .replace('/*__CORE__*/', () => safe(core))
  .replace('/*__VIEWER__*/', () => safe(src('viewer.js')));

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist', 'VisorDWF.html');
fs.writeFileSync(out, html);
console.log('Generado', out, (html.length / 1024).toFixed(0) + ' KB');
