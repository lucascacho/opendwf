/*
 * viewer.js — Interfaz y dibujo en canvas del Visor DWF.
 */
(function () {
  'use strict';
  var Core = window.DWFCore;
  var $ = function (id) { return document.getElementById(id); };

  // ───────────────────────────── Estado ─────────────────────────────
  var state = {
    doc: null, fileName: '', sheetIndex: -1, sheet: null, cache: {},
    view: { scale: 1, ox: 0, oy: 0 },
    dark: false, hidden: {}, weights: true,
    raf: 0, lastDrawMs: 0
  };
  var canvas = $('canvas'), ctx = canvas.getContext('2d');
  var stage = $('stage');

  // ───────────────────────────── Colores ─────────────────────────────
  var cssCache = new Map();
  function lum(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
  var bgRGB = [255, 255, 255];
  /** Convierte un color RGBA empaquetado a CSS, garantizando contraste con el fondo. */
  function css(c) {
    var s = cssCache.get(c);
    if (s) return s;
    var r = c >>> 24, g = (c >>> 16) & 255, b = (c >>> 8) & 255, a = c & 255;
    var sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat < 40 && Math.abs(lum(r, g, b) - lum(bgRGB[0], bgRGB[1], bgRGB[2])) < 0.18) {
      var v = lum(bgRGB[0], bgRGB[1], bgRGB[2]) > 0.5 ? 0 : 255;
      r = g = b = v;
    }
    s = a === 255 ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255).toFixed(3) + ')';
    cssCache.set(c, s);
    return s;
  }
  /** Color para rellenos: no se fuerza el contraste (un relleno blanco suele ser una máscara). */
  var fillCache = new Map();
  function cssFill(c) {
    var s = fillCache.get(c);
    if (s) return s;
    var r = c >>> 24, g = (c >>> 16) & 255, b = (c >>> 8) & 255, a = c & 255;
    if (state.dark && Math.max(r, g, b) - Math.min(r, g, b) < 40) {
      // Fondo oscuro: se invierte la escala de grises (blanco → fondo, negro → blanco).
      var t = 1 - lum(r, g, b);
      r = Math.round(bgRGB[0] + (255 - bgRGB[0]) * t); g = Math.round(bgRGB[1] + (255 - bgRGB[1]) * t); b = Math.round(bgRGB[2] + (255 - bgRGB[2]) * t);
    }
    s = a === 255 ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255).toFixed(3) + ')';
    fillCache.set(c, s);
    return s;
  }
  function setBackground(rgb) { bgRGB = rgb; cssCache.clear(); fillCache.clear(); }

  // ───────────────────────────── Dibujo ─────────────────────────────
  function sheetBackground(sheet) {
    if (state.dark) return [24, 26, 30];
    if (sheet.paper) return sheet.paper.color;
    for (var i = 0; i < sheet.layers.length; i++) {
      var d = sheet.layers[i].data;
      if (d && d.background != null) return [d.background >>> 24, (d.background >>> 16) & 255, (d.background >>> 8) & 255];
    }
    return [255, 255, 255];
  }

  function fontCss(f, px) {
    var name = String(f.name || 'Arial').replace(/["\\]/g, '').replace(/\.(shx|ttf|ttc|otf)$/i, '');
    var generic = /courier|mono|consol|txt|simplex|romans|isocp|monotxt/i.test(name) ? 'Menlo, Consolas, monospace'
      : /times|roman|serif|georgia|garamond/i.test(name) && !/sans/i.test(name) ? '"Times New Roman", Times, serif'
        : '"Helvetica Neue", Helvetica, Arial, sans-serif';
    if (/\b(cn|cond|condensed|narrow|compressed)\b/i.test(name)) generic = '"Arial Narrow", "Helvetica Neue Condensed", "Roboto Condensed", ' + generic;
    return (f.italic ? 'italic ' : '') + (f.bold ? 'bold ' : '') + px.toFixed(2) + 'px "' + name + '", ' + generic;
  }

  function decodeImage(it) {
    if (it._img !== undefined) return;
    it._img = null;
    if (!it.fmt || !it.data) return;
    if (it.fmt === 'jpeg' || it.fmt === 'png') {
      var blob = new Blob([it.data], { type: 'image/' + it.fmt });
      createImageBitmap(blob).then(function (bmp) { it._img = bmp; requestDraw(); }, function () { it._img = null; });
      return;
    }
    var w = it.cols, h = it.rows, n = w * h;
    if (!n || n > 64e6) return;
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c2 = cv.getContext('2d'), id = c2.createImageData(w, h), px = id.data, d = it.data, i;
    if (it.fmt === 'rgba' && d.length >= n * 4) px.set(d.subarray(0, n * 4));
    else if (it.fmt === 'rgb' && d.length >= n * 3) for (i = 0; i < n; i++) { px[i * 4] = d[i * 3]; px[i * 4 + 1] = d[i * 3 + 1]; px[i * 4 + 2] = d[i * 3 + 2]; px[i * 4 + 3] = 255; }
    else if (it.fmt === 'mapped' && it.cmap && d.length >= n) for (i = 0; i < n; i++) { var c = it.cmap[d[i]] || 0; px[i * 4] = c >>> 24; px[i * 4 + 1] = (c >>> 16) & 255; px[i * 4 + 2] = (c >>> 8) & 255; px[i * 4 + 3] = c & 255; }
    else return;
    c2.putImageData(id, 0, 0);
    it._img = cv;
  }

  /**
   * Dibuja una lista de elementos. T = matriz lógica→píxeles del canvas [a,b,c,d,e,f],
   * k = píxeles por unidad lógica, vis = rectángulo lógico visible, inherit = color heredado (macros).
   */
  function drawItems(c, items, T, k, vis, inherit, hidden) {
    var mode = 0;            // 0 nada, 1 trazo, 2 relleno de triángulos
    var curColor = -1, curW = -1, curDash = -1;
    var hair = 1 / k * (window.devicePixelRatio || 1);
    var useW = state.weights;

    function flush() {
      if (mode === 1) c.stroke();
      else if (mode === 2) c.fill();
      mode = 0;
    }
    function strokeStyle(col, w, dash) {
      if (mode !== 1 || col !== curColor || w !== curW || dash !== curDash) {
        flush();
        c.beginPath();
        c.strokeStyle = css(col);
        var lw = useW ? Math.max(w, hair) : hair;
        c.lineWidth = lw;
        var d = dash > 1 ? Core.DASHES[dash] : null;
        if (d) { var u = Math.max(lw, hair * 1.5); c.setLineDash(d.map(function (v) { return v * u; })); }
        else c.setLineDash(EMPTY);
        curColor = col; curW = w; curDash = dash; mode = 1;
      }
    }
    function fillStyle(col) {
      if (mode !== 2 || col !== curColor) {
        flush();
        c.beginPath();
        c.fillStyle = cssFill(col);
        curColor = col; mode = 2;
      }
    }
    function tri(ax, ay, bx, by, cx2, cy2) {
      // Orientación uniforme para que la unión no deje huecos ni costuras.
      if ((bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax) < 0) { var t = bx; bx = cx2; cx2 = t; t = by; by = cy2; cy2 = t; }
      c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(cx2, cy2); c.closePath();
    }

    for (var n = 0, len = items.length; n < len; n++) {
      var it = items[n], bb = it.bb;
      if (bb[2] < vis[0] || bb[0] > vis[2] || bb[3] < vis[1] || bb[1] > vis[3]) continue;
      if (hidden && hidden[it.L]) continue;
      var col = it.c === null ? inherit : it.c;
      var pts = it.pts, i, m;
      switch (it.k) {
        case 'l':
          strokeStyle(col, it.w, it.d);
          m = pts.length;
          if (m === 2 || (m === 4 && pts[0] === pts[2] && pts[1] === pts[3])) {
            // Punto: se dibuja como un trazo mínimo visible.
            var h2 = Math.max(it.w, hair) / 2;
            c.moveTo(pts[0] - h2, pts[1]); c.lineTo(pts[0] + h2, pts[1]);
          } else {
            c.moveTo(pts[0], pts[1]);
            for (i = 2; i < m; i += 2) c.lineTo(pts[i], pts[i + 1]);
          }
          break;
        case 't':
          fillStyle(col);
          for (i = 0, m = pts.length - 4; i < m; i += 2) tri(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
          break;
        case 'g':
          flush();
          c.beginPath();
          c.moveTo(pts[0], pts[1]);
          for (i = 2, m = pts.length; i < m; i += 2) c.lineTo(pts[i], pts[i + 1]);
          c.closePath();
          c.fillStyle = cssFill(col);
          c.fill('evenodd');
          break;
        case 'c': {
          flush();
          c.beginPath();
          var q = 0;
          for (var ci = 0; ci < it.n.length; ci++) {
            var cnt = it.n[ci];
            if (cnt > 0) {
              c.moveTo(pts[q], pts[q + 1]);
              for (i = 1; i < cnt; i++) c.lineTo(pts[q + i * 2], pts[q + i * 2 + 1]);
              c.closePath();
            }
            q += cnt * 2;
          }
          c.fillStyle = cssFill(col);
          c.fill('evenodd');
          break;
        }
        case 'e': {
          var a0 = it.s / 65536 * 2 * Math.PI, a1 = it.e / 65536 * 2 * Math.PI, tilt = it.t / 65536 * 2 * Math.PI;
          var full = it.e - it.s >= 65536;
          var ra = Math.abs(it.a), rb = Math.abs(it.b);
          if (it.f) {
            flush();
            c.beginPath();
            if (!full) c.moveTo(it.x, it.y);
            c.ellipse(it.x, it.y, ra, rb, tilt, a0, a1, false);
            c.closePath();
            c.fillStyle = cssFill(col);
            c.fill();
          } else {
            strokeStyle(col, it.w, it.d);
            c.moveTo(it.x + Math.cos(tilt) * ra * Math.cos(a0) - Math.sin(tilt) * rb * Math.sin(a0),
              it.y + Math.sin(tilt) * ra * Math.cos(a0) + Math.cos(tilt) * rb * Math.sin(a0));
            c.ellipse(it.x, it.y, ra, rb, tilt, a0, a1, false);
          }
          break;
        }
        case 'x':
          flush();
          drawText(c, it, T, k, col);
          break;
        case 'p': {
          fillStyle(col);
          var r = hair * 1.2;
          for (i = 0, m = pts.length; i < m; i += 2) { c.moveTo(pts[i] + r, pts[i + 1]); c.arc(pts[i], pts[i + 1], r, 0, 6.2832); }
          break;
        }
        case 'gt':
          flush();
          for (i = 0, m = pts.length / 2 - 2; i < m; i++) {
            c.beginPath();
            c.moveTo(pts[i * 2], pts[i * 2 + 1]); c.lineTo(pts[i * 2 + 2], pts[i * 2 + 3]); c.lineTo(pts[i * 2 + 4], pts[i * 2 + 5]);
            c.closePath();
            var mix = avgColor(it.cols[i], it.cols[i + 1], it.cols[i + 2]);
            c.fillStyle = css(mix); c.strokeStyle = css(mix); c.lineWidth = hair * 0.5; c.setLineDash(EMPTY);
            c.fill(); c.stroke();
          }
          break;
        case 'gl':
          flush();
          c.lineWidth = useW ? Math.max(it.w, hair) : hair; c.setLineDash(EMPTY);
          for (i = 0, m = pts.length / 2 - 1; i < m; i++) {
            c.beginPath();
            c.moveTo(pts[i * 2], pts[i * 2 + 1]); c.lineTo(pts[i * 2 + 2], pts[i * 2 + 3]);
            c.strokeStyle = css(avgColor(it.cols[i], it.cols[i + 1], it.cols[i + 1]));
            c.stroke();
          }
          break;
        case 'i': {
          flush();
          decodeImage(it);
          var x0 = Math.min(it.x0, it.x1), x1 = Math.max(it.x0, it.x1), y0 = Math.min(it.y0, it.y1), y1 = Math.max(it.y0, it.y1);
          if (it._img) {
            c.save();
            c.transform(1, 0, 0, -1, 0, y1);
            c.imageSmoothingEnabled = (x1 - x0) * k < it._img.width * 2;
            c.drawImage(it._img, x0, 0, x1 - x0, y1 - y0);
            c.restore();
          } else if (!it.fmt) {
            c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0);
            c.strokeStyle = 'rgba(128,128,128,.7)'; c.lineWidth = hair; c.setLineDash([hair * 4, hair * 4]); c.stroke();
          }
          break;
        }
        case 'm': {
          flush();
          var sc = it.sc;
          for (i = 0, m = pts.length; i < m; i += 2) {
            var px = pts[i], py = pts[i + 1];
            c.save();
            c.transform(sc, 0, 0, sc, px, py);
            var T2 = [T[0] * sc, T[1] * sc, T[2] * sc, T[3] * sc, T[0] * px + T[2] * py + T[4], T[1] * px + T[3] * py + T[5]];
            var v2 = [(vis[0] - px) / sc, (vis[1] - py) / sc, (vis[2] - px) / sc, (vis[3] - py) / sc];
            if (sc < 0) v2 = [v2[2], v2[3], v2[0], v2[1]];
            drawItems(c, it.items, T2, k * Math.abs(sc), v2, col, null);
            c.restore();
          }
          break;
        }
      }
    }
    flush();
    c.setLineDash(EMPTY);
  }
  var EMPTY = [];

  function avgColor(a, b, c3) {
    var r = ((a >>> 24) + (b >>> 24) + (c3 >>> 24)) / 3, g = (((a >>> 16) & 255) + ((b >>> 16) & 255) + ((c3 >>> 16) & 255)) / 3;
    var bl = (((a >>> 8) & 255) + ((b >>> 8) & 255) + ((c3 >>> 8) & 255)) / 3, al = ((a & 255) + (b & 255) + (c3 & 255)) / 3;
    return ((Math.round(r) << 24) | (Math.round(g) << 16) | (Math.round(bl) << 8) | Math.round(al)) >>> 0;
  }

  var FONT_EM = 1.0; // relación entre la altura de fuente DWF y el tamaño "em"
  function drawText(c, it, T, k, col) {
    var f = it.f, hgt = Math.abs(f.height);
    var px = hgt * k * FONT_EM;
    if (px < 1.2) {
      return; // ilegible a esta escala
    }
    var sx = T[0] * it.x + T[2] * it.y + T[4], sy = T[1] * it.x + T[3] * it.y + T[5];
    // Dirección de la línea base en pantalla (incluye la orientación de la hoja)
    var ang = f.rotation / 65536 * 2 * Math.PI;
    var ux = Math.cos(ang), uy = Math.sin(ang);
    if (it.bd) {
      // El recuadro del texto indica la dirección real de la línea base (más fiable que la fuente).
      var bx = it.bd[2] - it.bd[0], by = it.bd[3] - it.bd[1], bl = Math.hypot(bx, by);
      if (bl > 0) { ux = bx / bl; uy = by / bl; }
    }
    var dx = T[0] * ux + T[2] * uy, dy = T[1] * ux + T[3] * uy;
    var rot = Math.atan2(dy, dx);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(sx, sy);
    c.rotate(rot);
    var obl = f.oblique ? Math.tan(f.oblique / 65536 * 2 * Math.PI) : 0;
    var ws = (f.widthScale || 1024) / 1024;
    c.font = fontCss(f, px);
    var fit = 1;
    if (it.bd) {
      var bw = Math.hypot(it.bd[2] - it.bd[0], it.bd[3] - it.bd[1]) * k;
      var mw = c.measureText(it.s).width;
      if (mw > 0 && bw > 0) { fit = bw / mw; if (fit < 0.4 || fit > 2.5) fit = ws; }
    } else fit = ws;
    if (fit !== 1 || obl) c.transform(fit, 0, -obl, 1, 0, 0);
    c.textAlign = it.ha === 1 ? 'center' : it.ha === 2 ? 'right' : 'left';
    c.textBaseline = it.va === 2 ? 'middle' : it.va >= 3 ? 'top' : 'alphabetic';
    c.fillStyle = css(col);
    c.fillText(it.s, 0, 0);
    if (f.underline) {
      var w = c.measureText(it.s).width;
      c.fillRect(0, px * 0.08, w, Math.max(1, px * 0.06));
    }
    c.restore();
  }

  /** Dibuja la hoja completa en un contexto dado. */
  function renderSheet(c, sheet, view, W, H, dpr, opts) {
    opts = opts || {};
    var bg = sheetBackground(sheet);
    setBackground(bg);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    var s = view.scale * dpr, ox = view.ox * dpr, oy = view.oy * dpr;
    var bgCss = 'rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')';

    c.save();
    if (sheet.paper) {
      var pw = sheet.paper.width * s, ph = sheet.paper.height * s, pxl = ox, pyt = oy - ph;
      if (!opts.transparentDesk) {
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--desk').trim() || '#d7d9de';
        c.fillRect(0, 0, W, H);
        c.shadowColor = 'rgba(0,0,0,.28)'; c.shadowBlur = 18 * dpr; c.shadowOffsetY = 3 * dpr;
      }
      c.fillStyle = bgCss;
      c.fillRect(pxl, pyt, pw, ph);
      c.shadowColor = 'transparent';
      c.beginPath(); c.rect(pxl, pyt, pw, ph); c.clip();
    } else {
      c.fillStyle = bgCss;
      c.fillRect(0, 0, W, H);
    }

    c.lineJoin = 'round'; c.lineCap = 'round';
    for (var li = 0; li < sheet.layers.length; li++) {
      var L = sheet.layers[li], m = L.m;
      var T = [m[0] * s, -m[1] * s, m[2] * s, -m[3] * s, m[4] * s + ox, -m[5] * s + oy];
      var det = T[0] * T[3] - T[1] * T[2];
      if (!det) continue;
      var k = Math.sqrt(Math.abs(det));
      c.save();
      if (L.clip && sheet.paper) {
        c.beginPath();
        c.rect(L.clip[0] * s + ox, oy - L.clip[3] * s, (L.clip[2] - L.clip[0]) * s, (L.clip[3] - L.clip[1]) * s);
        c.clip();
      }
      c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
      if (L.raster) {
        drawRaster(c, L);
      } else {
        // Rectángulo visible en coordenadas lógicas
        var inv = [T[3] / det, -T[1] / det, -T[2] / det, T[0] / det];
        var corners = [[0, 0], [W, 0], [W, H], [0, H]], vis = [Infinity, Infinity, -Infinity, -Infinity];
        for (var q = 0; q < 4; q++) {
          var X = corners[q][0] - T[4], Y = corners[q][1] - T[5];
          var lx = inv[0] * X + inv[2] * Y, ly = inv[1] * X + inv[3] * Y;
          if (lx < vis[0]) vis[0] = lx; if (lx > vis[2]) vis[2] = lx;
          if (ly < vis[1]) vis[1] = ly; if (ly > vis[3]) vis[3] = ly;
        }
        var hidden = li === 0 ? state.hidden : null;
        var hasHidden = false; if (hidden) for (var hk in hidden) if (hidden[hk]) { hasHidden = true; break; }
        drawItems(c, L.data.items, T, k, vis, 0x000000ff, hasHidden ? hidden : null);
      }
      c.restore();
    }
    c.restore();
  }

  function drawRaster(c, L) {
    var r = L.raster;
    if (r._img === undefined) {
      r._img = null;
      createImageBitmap(new Blob([r.data], { type: r.mime })).then(function (b) { r._img = b; requestDraw(); }, function () { });
    }
    if (!r._img) return;
    var e = L.extents && L.extents.length === 4 ? L.extents : [0, 0, r._img.width, r._img.height];
    c.save();
    c.transform(1, 0, 0, -1, 0, e[3]);
    c.drawImage(r._img, e[0], 0, e[2] - e[0], e[3] - e[1]);
    c.restore();
  }

  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1, r = stage.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function draw() {
    state.raf = 0;
    if (!state.sheet) return;
    resizeCanvas();
    var dpr = window.devicePixelRatio || 1, t0 = performance.now();
    renderSheet(ctx, state.sheet, state.view, canvas.width, canvas.height, dpr);
    state.lastDrawMs = performance.now() - t0;
    $('zoomLabel').textContent = zoomText();
  }
  function requestDraw() { if (!state.raf) state.raf = requestAnimationFrame(draw); }

  // ───────────────────────────── Vista ─────────────────────────────
  function fitRect(sheet) {
    if (sheet.paper) return [0, 0, sheet.paper.width, sheet.paper.height];
    return sheet.extent || [0, 0, 1, 1];
  }
  function fit() {
    var sh = state.sheet; if (!sh) return;
    var r = stage.getBoundingClientRect(), e = fitRect(sh), pad = sh.paper ? 28 : 20;
    var w = Math.max(e[2] - e[0], 1e-9), h = Math.max(e[3] - e[1], 1e-9);
    var sc = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
    if (!(sc > 0) || !isFinite(sc)) sc = 1;
    state.view.scale = sc; state.fitScale = sc;
    state.view.ox = r.width / 2 - (e[0] + w / 2) * sc;
    state.view.oy = r.height / 2 + (e[1] + h / 2) * sc;
    requestDraw();
  }
  function zoomAt(factor, px, py) {
    var v = state.view, min = (state.fitScale || 1) / 20, max = (state.fitScale || 1) * 4000;
    var ns = Math.min(max, Math.max(min, v.scale * factor)), f = ns / v.scale;
    v.ox = px - (px - v.ox) * f; v.oy = py - (py - v.oy) * f; v.scale = ns;
    requestDraw();
  }
  function zoomCenter(f) { var r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
  function zoomText() {
    var sh = state.sheet; if (!sh) return '';
    if (sh.paper) {
      var perInch = sh.paper.units === 'mm' ? 25.4 : 1;
      return Math.round(state.view.scale * perInch / 96 * 100) + ' %';
    }
    return Math.round(state.view.scale / (state.fitScale || 1) * 100) + ' %';
  }

  // ───────────────────────────── Interacción ─────────────────────────────
  var drag = null;
  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    if (!state.sheet) return;
    drag = { x: e.clientX, y: e.clientY, ox: state.view.ox, oy: state.view.oy };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', function (e) {
    if (drag) {
      state.view.ox = drag.ox + (e.clientX - drag.x); state.view.oy = drag.oy + (e.clientY - drag.y);
      requestDraw();
    }
    updateCoords(e);
  });
  function endDrag() { drag = null; stage.classList.remove('dragging'); }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', function () { $('coords').textContent = ''; });
  stage.addEventListener('wheel', function (e) {
    if (!state.sheet) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      state.view.ox -= e.deltaX || e.deltaY; state.view.oy -= e.deltaX ? e.deltaY : 0; requestDraw(); return;
    }
    var dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    var k = e.ctrlKey ? 0.01 : 0.0022;       // ctrl = gesto de pellizco en trackpad
    zoomAt(Math.exp(-Math.max(-150, Math.min(150, dy)) * k), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Pellizco en Safari
  var gestureScale = 1;
  stage.addEventListener('gesturestart', function (e) { e.preventDefault(); gestureScale = 1; });
  stage.addEventListener('gesturechange', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomAt(e.scale / gestureScale, e.clientX - r.left, e.clientY - r.top);
    gestureScale = e.scale;
  });
  stage.addEventListener('dblclick', function (e) {
    var r = stage.getBoundingClientRect(); zoomAt(e.altKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
  });

  function updateCoords(e) {
    var sh = state.sheet; if (!sh) return;
    var r = stage.getBoundingClientRect(), v = state.view;
    var wx = (e.clientX - r.left - v.ox) / v.scale, wy = -(e.clientY - r.top - v.oy) / v.scale;
    var txt;
    if (sh.paper) {
      var u = sh.paper.units === 'mm' ? 'mm' : sh.paper.units === 'in' ? 'in' : sh.paper.units;
      var dec = u === 'mm' ? 1 : 3;
      txt = 'X ' + wx.toFixed(dec) + '  Y ' + wy.toFixed(dec) + ' ' + u;
    } else txt = 'X ' + Math.round(wx) + '  Y ' + Math.round(wy);
    $('coords').textContent = txt;
  }

  window.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); $('file').click(); return; }
    if (!state.sheet) return;
    var step = 80;
    switch (e.key) {
      case '+': case '=': e.preventDefault(); zoomCenter(1.3); break;
      case '-': case '_': e.preventDefault(); zoomCenter(1 / 1.3); break;
      case '0': case 'f': case 'F': if (!mod || e.key === '0') { e.preventDefault(); fit(); } break;
      case 'ArrowLeft': state.view.ox += step; requestDraw(); break;
      case 'ArrowRight': state.view.ox -= step; requestDraw(); break;
      case 'ArrowUp': state.view.oy += step; requestDraw(); break;
      case 'ArrowDown': state.view.oy -= step; requestDraw(); break;
      case 'PageDown': case ']': e.preventDefault(); showSheet(state.sheetIndex + 1); break;
      case 'PageUp': case '[': e.preventDefault(); showSheet(state.sheetIndex - 1); break;
    }
  });
  new ResizeObserver(function () { if (state.sheet) requestDraw(); }).observe(stage);

  // ───────────────────────────── Archivos ─────────────────────────────
  function showError(msg) {
    $('errorText').textContent = msg;
    $('error').hidden = false;
  }
  $('errorClose').addEventListener('click', function () { $('error').hidden = true; });

  function openFile(file) {
    if (!file) return;
    $('error').hidden = true;
    document.body.classList.add('busy');
    var reader = new FileReader();
    reader.onerror = function () { document.body.classList.remove('busy'); showError('No se pudo leer el archivo.'); };
    reader.onload = function () {
      setTimeout(function () {
        try {
          loadBytes(new Uint8Array(reader.result), file.name);
        } catch (err) {
          console.error(err);
          showError((err && err.message) || 'No se pudo abrir el archivo.');
        }
        document.body.classList.remove('busy');
      }, 20);
    };
    reader.readAsArrayBuffer(file);
  }

  function loadBytes(bytes, name) {
    var doc = Core.openDWF(bytes, name);
    state.doc = doc; state.fileName = name; state.cache = {}; state.sheet = null; state.sheetIndex = -1;
    document.title = name + ' — Visor DWF';
    $('fileName').textContent = name;
    document.body.classList.add('has-doc');
    buildSheetList();
    var first = 0;
    for (var i = 0; i < doc.sheets.length; i++) if (doc.sheets[i].kind === '2d') { first = i; break; }
    showSheet(first);
  }

  function buildSheetList() {
    var list = $('sheets'); list.textContent = '';
    var doc = state.doc;
    doc.sheets.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'sheet'; b.type = 'button'; b.dataset.i = i;
      var th = document.createElement('span'); th.className = 'thumb';
      var t = doc.thumbnail ? doc.thumbnail(i) : null;
      if (t) {
        var img = document.createElement('img'); img.alt = '';
        img.src = URL.createObjectURL(new Blob([t.data], { type: t.mime }));
        th.appendChild(img);
      } else th.textContent = s.kind === '3d' ? '3D' : (i + 1);
      var lab = document.createElement('span'); lab.className = 'label';
      var num = document.createElement('span'); num.className = 'num'; num.textContent = (i + 1);
      var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = s.title; nm.title = s.title;
      lab.appendChild(num); lab.appendChild(nm);
      b.appendChild(th); b.appendChild(lab);
      b.addEventListener('click', function () { showSheet(i); });
      list.appendChild(b);
    });
    document.body.classList.toggle('single', doc.sheets.length < 2);
    $('sheetCount').textContent = doc.sheets.length === 1 ? '1 hoja' : doc.sheets.length + ' hojas';
  }

  function showSheet(i) {
    var doc = state.doc;
    if (!doc || i < 0 || i >= doc.sheets.length) return;
    var sh = state.cache[i];
    if (!sh) {
      try { sh = state.cache[i] = doc.loadSheet(i); }
      catch (err) { console.error(err); showError('No se pudo leer la hoja «' + doc.sheets[i].title + '»: ' + err.message); return; }
    }
    state.sheetIndex = i; state.sheet = sh; state.hidden = {};
    Array.prototype.forEach.call($('sheets').children, function (b, k) {
      b.classList.toggle('active', k === i);
      if (k === i && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    });
    buildLayerList(sh);
    var notes = [];
    if (sh.kind === '3d') notes.push('Esta hoja contiene un modelo 3D, que este visor no puede mostrar (solo planos 2D).');
    else if (!sh.layers.length || !sh.extent) notes.push('Esta hoja no contiene dibujo 2D.');
    sh.warnings.forEach(function (w) { notes.push(w); });
    var un = Object.keys(sh.unsupported);
    if (un.length) notes.push('Elementos no mostrados: ' + un.map(function (k) { return k + ' (' + sh.unsupported[k] + ')'; }).join(', ') + '.');
    $('notice').hidden = !notes.length;
    $('noticeText').textContent = notes.join(' ');
    $('sheetTitle').textContent = sh.title;
    var info = [];
    if (sh.paper) info.push(fmtPaper(sh.paper));
    $('sheetInfo').textContent = info.join(' · ');
    fit();
    draw();
  }
  function fmtPaper(p) {
    var mm = p.units === 'mm' ? 1 : p.units === 'in' ? 25.4 : 0;
    if (!mm) return p.width.toFixed(1) + ' × ' + p.height.toFixed(1) + ' ' + p.units;
    var w = p.width * mm, h = p.height * mm;
    var sizes = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], Carta: [215.9, 279.4], Oficio: [215.9, 355.6], 'ANSI B': [279.4, 431.8], 'ANSI C': [431.8, 558.8], 'ANSI D': [558.8, 863.6], 'ANSI E': [863.6, 1117.6], 'Arch D': [609.6, 914.4], 'Arch E': [914.4, 1219.2] };
    var lo = Math.min(w, h), hi = Math.max(w, h), name = '';
    for (var k in sizes) if (Math.abs(sizes[k][0] - lo) < 2.5 && Math.abs(sizes[k][1] - hi) < 2.5) { name = k + ' · '; break; }
    return name + Math.round(w) + ' × ' + Math.round(h) + ' mm';
  }

  function buildLayerList(sh) {
    var box = $('layers'); box.textContent = '';
    var layers = sh.layers.length && sh.layers[0].data ? sh.layers[0].data.layers : [];
    $('btnLayers').disabled = !layers.length;
    if (!layers.length) { document.body.classList.remove('show-layers'); return; }
    layers.forEach(function (L) {
      var lab = document.createElement('label'); lab.className = 'layer';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
      cb.addEventListener('change', function () { state.hidden[L.id] = !cb.checked; requestDraw(); });
      var sp = document.createElement('span'); sp.textContent = L.name; sp.title = L.name;
      lab.appendChild(cb); lab.appendChild(sp);
      box.appendChild(lab);
    });
  }
  function setAllLayers(on) {
    Array.prototype.forEach.call($('layers').querySelectorAll('input'), function (cb) {
      if (cb.checked !== on) { cb.checked = on; cb.dispatchEvent(new Event('change')); }
    });
  }

  // ───────────────────────────── Exportar ─────────────────────────────
  function exportPNG() {
    var sh = state.sheet; if (!sh) return;
    var e = fitRect(sh), w = e[2] - e[0], h = e[3] - e[1];
    var maxSide = 6000, sc = maxSide / Math.max(w, h);
    if (sh.paper) { var dpi = 200, perUnit = sh.paper.units === 'mm' ? dpi / 25.4 : dpi; sc = Math.min(sc, perUnit); }
    var W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var view = { scale: sc, ox: -e[0] * sc, oy: e[3] * sc };
    renderSheet(cv.getContext('2d'), sh, view, W, H, 1, { transparentDesk: true });
    setBackground(sheetBackground(sh));
    cv.toBlob(function (blob) {
      if (!blob) { showError('No se pudo generar la imagen.'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.fileName.replace(/\.[^.]+$/, '') + ' - ' + sh.title).replace(/[\\/:*?"<>|]+/g, '_') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    }, 'image/png');
    requestDraw();
  }

  // ───────────────────────────── Controles ─────────────────────────────
  $('file').addEventListener('change', function () { openFile(this.files[0]); this.value = ''; });
  ['btnOpen', 'btnOpenBig'].forEach(function (id) { $(id).addEventListener('click', function () { $('file').click(); }); });
  $('btnZoomIn').addEventListener('click', function () { zoomCenter(1.4); });
  $('btnZoomOut').addEventListener('click', function () { zoomCenter(1 / 1.4); });
  $('btnFit').addEventListener('click', fit);
  $('btnDark').addEventListener('click', function () {
    state.dark = !state.dark; this.setAttribute('aria-pressed', state.dark); requestDraw();
  });
  $('btnWeights').addEventListener('click', function () {
    state.weights = !state.weights; this.setAttribute('aria-pressed', state.weights); requestDraw();
  });
  $('btnLayers').addEventListener('click', function () {
    var on = document.body.classList.toggle('show-layers'); this.setAttribute('aria-pressed', on);
  });
  $('btnExport').addEventListener('click', exportPNG);
  $('layersAll').addEventListener('click', function () { setAllLayers(true); });
  $('layersNone').addEventListener('click', function () { setAllLayers(false); });
  $('noticeClose').addEventListener('click', function () { $('notice').hidden = true; });

  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);

  // Para pruebas automáticas
  window.VisorDWF = { loadBytes: loadBytes, state: state, fit: fit, showSheet: showSheet, draw: draw };
})();
