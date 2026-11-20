/*
 * dwf-core.js — Decodificador de archivos DWF (Design Web Format) 2D.
 *
 * Contiene: inflate (con diccionario y posición final), lector ZIP,
 * analizador de flujos W2D (WHIP!) y lector del paquete DWF 6.
 * Sin dependencias; funciona en navegador y en Node.
 */
(function (root) {
  'use strict';

  var TABLES = /*__TABLES__*/ null;
  if (!TABLES && typeof require === 'function') {
    try { TABLES = require('./tables.json'); } catch (e) { /* se inyecta al compilar */ }
  }

  // ───────────────────────────── Inflate ─────────────────────────────

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildHuff(lens, off, n) {
    var max = 0, i;
    for (i = 0; i < n; i++) if (lens[off + i] > max) max = lens[off + i];
    if (max === 0) return { table: new Uint32Array(1), bits: 0 };
    var count = new Uint16Array(16), next = new Uint16Array(16);
    for (i = 0; i < n; i++) count[lens[off + i]]++;
    count[0] = 0;
    var code = 0, bits;
    for (bits = 1; bits <= 15; bits++) { code = (code + count[bits - 1]) << 1; next[bits] = code; }
    var size = 1 << max, table = new Uint32Array(size);
    for (i = 0; i < n; i++) {
      var len = lens[off + i];
      if (!len) continue;
      var c = next[len]++, r = 0, k;
      for (k = 0; k < len; k++) { r = (r << 1) | (c & 1); c >>= 1; }
      var entry = (len << 16) | i, step = 1 << len;
      for (k = r; k < size; k += step) table[k] = entry;
    }
    return { table: table, bits: max };
  }

  var FIXED_LIT = null, FIXED_DIST = null;
  function fixedTables() {
    if (FIXED_LIT) return;
    var l = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildHuff(l, 0, 288);
    var d = new Uint8Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    FIXED_DIST = buildHuff(d, 0, 30);
  }

  /**
   * Descomprime un flujo deflate "crudo" que comienza en src[pos].
   * Devuelve { out, pos } donde pos es el byte siguiente al final del flujo.
   */
  function inflateRaw(src, pos, dict, sizeHint) {
    var dictLen = dict ? dict.length : 0;
    var cap = Math.max(1024, (sizeHint || (src.length - pos) * 4) + dictLen);
    var out = new Uint8Array(cap);
    if (dictLen) out.set(dict, 0);
    var op = dictLen;
    var bitbuf = 0, bitcnt = 0;
    var srcLen = src.length;

    function grow(need) {
      var n = cap;
      while (n < need) n *= 2;
      var o = new Uint8Array(n);
      o.set(out.subarray(0, op), 0);
      out = o; cap = n;
    }

    var last = 0;
    while (!last) {
      while (bitcnt < 3) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
      last = bitbuf & 1;
      var type = (bitbuf >> 1) & 3;
      bitbuf >>>= 3; bitcnt -= 3;
      if (pos > srcLen + 8) throw new Error('Datos comprimidos truncados');

      if (type === 0) {
        var drop = bitcnt & 7;
        bitbuf >>>= drop; bitcnt -= drop;
        pos -= bitcnt >> 3; bitbuf = 0; bitcnt = 0;
        var len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > srcLen) throw new Error('Datos comprimidos truncados');
        if (op + len > cap) grow(op + len);
        out.set(src.subarray(pos, pos + len), op);
        op += len; pos += len;
        continue;
      }
      if (type === 3) throw new Error('Bloque deflate inválido');

      var lit, dist;
      if (type === 1) {
        fixedTables(); lit = FIXED_LIT; dist = FIXED_DIST;
      } else {
        while (bitcnt < 14) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
        var hlit = (bitbuf & 31) + 257, hdist = ((bitbuf >> 5) & 31) + 1, hclen = ((bitbuf >> 10) & 15) + 4;
        bitbuf >>>= 14; bitcnt -= 14;
        var cl = new Uint8Array(19), i;
        for (i = 0; i < hclen; i++) {
          while (bitcnt < 3) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
          cl[CL_ORDER[i]] = bitbuf & 7; bitbuf >>>= 3; bitcnt -= 3;
        }
        var clh = buildHuff(cl, 0, 19), clt = clh.table, clm = (1 << clh.bits) - 1;
        var lens = new Uint8Array(hlit + hdist), n = 0;
        while (n < hlit + hdist) {
          while (bitcnt < 15) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
          var e = clt[bitbuf & clm], el = e >>> 16, sym = e & 0xffff;
          if (!el) throw new Error('Código Huffman inválido');
          bitbuf >>>= el; bitcnt -= el;
          if (sym < 16) { lens[n++] = sym; continue; }
          while (bitcnt < 7) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
          var rep, val = 0;
          if (sym === 16) { if (!n) throw new Error('Repetición inválida'); val = lens[n - 1]; rep = 3 + (bitbuf & 3); bitbuf >>>= 2; bitcnt -= 2; }
          else if (sym === 17) { rep = 3 + (bitbuf & 7); bitbuf >>>= 3; bitcnt -= 3; }
          else { rep = 11 + (bitbuf & 127); bitbuf >>>= 7; bitcnt -= 7; }
          if (n + rep > hlit + hdist) throw new Error('Longitudes de código inválidas');
          while (rep--) lens[n++] = val;
        }
        lit = buildHuff(lens, 0, hlit);
        dist = buildHuff(lens, hlit, hdist);
      }

      var lt = lit.table, lm = (1 << lit.bits) - 1, dt = dist.table, dm = (1 << dist.bits) - 1;
      for (;;) {
        while (bitcnt < 15) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
        var en = lt[bitbuf & lm], nb = en >>> 16, s = en & 0xffff;
        if (!nb) throw new Error('Código Huffman inválido');
        bitbuf >>>= nb; bitcnt -= nb;
        if (s < 256) {
          if (op >= cap) grow(op + 1);
          out[op++] = s;
          continue;
        }
        if (s === 256) break;
        s -= 257;
        if (s > 28) throw new Error('Longitud inválida');
        var mlen = LEN_BASE[s], eb = LEN_EXTRA[s];
        if (eb) {
          while (bitcnt < eb) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
          mlen += bitbuf & ((1 << eb) - 1); bitbuf >>>= eb; bitcnt -= eb;
        }
        while (bitcnt < 15) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
        var de = dt[bitbuf & dm], db = de >>> 16, ds = de & 0xffff;
        if (!db || ds > 29) throw new Error('Distancia inválida');
        bitbuf >>>= db; bitcnt -= db;
        var d = DIST_BASE[ds], dx = DIST_EXTRA[ds];
        if (dx) {
          while (bitcnt < dx) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
          d += bitbuf & ((1 << dx) - 1); bitbuf >>>= dx; bitcnt -= dx;
        }
        if (d > op) throw new Error('Distancia fuera de rango');
        if (op + mlen > cap) grow(op + mlen);
        var from = op - d;
        if (d >= mlen) { out.copyWithin(op, from, from + mlen); op += mlen; }
        else { while (mlen--) out[op++] = out[from++]; }
        if (pos > srcLen + 8) throw new Error('Datos comprimidos truncados');
      }
    }
    pos -= bitcnt >> 3;
    return { out: out.subarray(dictLen, op), pos: pos };
  }

  /** Flujo zlib (cabecera de 2 bytes, diccionario opcional, adler32 final). */
  function inflateZlib(src, pos, dict) {
    var flg = src[pos + 1];
    pos += 2;
    var useDict = (flg & 0x20) !== 0;
    if (useDict) pos += 4;
    var r = inflateRaw(src, pos, useDict ? dict : null);
    r.pos += 4;
    return r;
  }

  // ───────────────────────────── ZIP ─────────────────────────────

  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

  function decodeBytes(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) {
      try { return new TextDecoder('windows-1252').decode(bytes); }
      catch (e2) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
    }
  }

  function Zip(bytes) {
    this.bytes = bytes;
    this.entries = [];
    this.index = {};
    var b = bytes, n = b.length, eocd = -1;
    for (var i = n - 22; i >= 0 && i >= n - 22 - 65536; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No es un paquete DWF válido (no se encontró el índice ZIP).');
    var total = u16(b, eocd + 10), cdSize = u32(b, eocd + 12), cdOff = u32(b, eocd + 16);
    var base = 0;
    if (u32(b, cdOff) !== 0x02014b50) {
      var alt = eocd - cdSize;
      if (alt >= 0 && u32(b, alt) === 0x02014b50) base = alt - cdOff;
      else throw new Error('Índice ZIP dañado.');
    }
    var p = cdOff + base;
    for (var k = 0; k < total && p + 46 <= n; k++) {
      if (u32(b, p) !== 0x02014b50) break;
      var flags = u16(b, p + 8), method = u16(b, p + 10);
      var csize = u32(b, p + 20), usize = u32(b, p + 24);
      var nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32);
      var lho = u32(b, p + 42) + base;
      var name = decodeBytes(b.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
      var ent = { name: name, method: method, csize: csize, usize: usize, offset: lho, encrypted: (flags & 1) !== 0 };
      this.entries.push(ent);
      this.index[name.toLowerCase()] = ent;
      p += 46 + nl + xl + cl;
    }
  }
  Zip.prototype.find = function (name) {
    return this.index[String(name).replace(/\\/g, '/').toLowerCase()] || null;
  };
  Zip.prototype.read = function (ent) {
    if (typeof ent === 'string') ent = this.find(ent);
    if (!ent) return null;
    if (ent.encrypted) throw new Error('El archivo DWF está protegido con contraseña.');
    var b = this.bytes, p = ent.offset;
    if (u32(b, p) !== 0x04034b50) throw new Error('Entrada ZIP dañada: ' + ent.name);
    var start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
    if (ent.method === 0) return b.subarray(start, start + ent.usize);
    if (ent.method === 8) return inflateRaw(b, start, null, ent.usize).out;
    throw new Error('Método de compresión ZIP no soportado (' + ent.method + ').');
  };
  Zip.prototype.readText = function (ent) {
    var d = this.read(ent);
    return d ? decodeBytes(d) : null;
  };

  // ───────────────────────────── W2D ─────────────────────────────

  var LINE_PATTERNS = ['', 'Solid', 'Dashed', 'Dotted', 'Dash_Dot', 'Short_Dash', 'Medium_Dash', 'Long_Dash',
    'Short_Dash_X2', 'Medium_Dash_X2', 'Long_Dash_X2', 'Medium_Long_Dash', 'Medium_Dash_Short_Dash_Short_Dash',
    'Long_Dash_Short_Dash', 'Long_Dash_Dot_Dot', 'Long_Dash_Dot', 'Medium_Dash_Dot_Short_Dash_Dot', 'Sparse_Dot',
    'ISO_Dash', 'ISO_Dash_Space', 'ISO_Long_Dash_Dot', 'ISO_Long_Dash_Double_Dot', 'ISO_Long_Dash_Triple_Dot',
    'ISO_Dot', 'ISO_Long_Dash_Short_Dash', 'ISO_Long_Dash_Double_Short_Dash', 'ISO_Dash_Dot', 'ISO_Double_Dash_Dot',
    'ISO_Dash_Double_Dot', 'ISO_Double_Dash_Double_Dot', 'ISO_Dash_Triple_Dot', 'ISO_Double_Dash_Triple_Dot',
    'Decorated_Tracks', 'Decorated_Wide_Tracks', 'Decorated_Circle_Fence', 'Decorated_Square_Fence'];
  // Trazos en múltiplos del grosor de referencia (se escalan en pantalla).
  var DASHES = {
    2: [6, 4], 3: [1, 3], 4: [6, 3, 1, 3], 5: [3, 3], 6: [6, 3], 7: [10, 3], 8: [6, 6], 9: [12, 6], 10: [20, 6],
    11: [6, 3, 12, 3], 12: [6, 3, 3, 3, 3, 3], 13: [10, 3, 3, 3], 14: [10, 3, 1, 3, 1, 3], 15: [10, 3, 1, 3],
    16: [6, 3, 1, 3, 3, 3, 1, 3], 17: [1, 6], 18: [12, 3], 19: [12, 18], 20: [24, 3, 1, 3], 21: [24, 3, 1, 3, 1, 3],
    22: [24, 3, 1, 3, 1, 3, 1, 3], 23: [1, 3], 24: [24, 3, 6, 3], 25: [24, 3, 6, 3, 6, 3], 26: [12, 3, 1, 3],
    27: [12, 3, 12, 3, 1, 3], 28: [12, 3, 1, 3, 1, 3], 29: [12, 3, 12, 3, 1, 3, 1, 3], 30: [12, 3, 1, 3, 1, 3, 1, 3],
    31: [12, 3, 12, 3, 1, 3, 1, 3, 1, 3]
  };

  function isWs(c) { return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x00; }
  function isDigit(c) { return c >= 0x30 && c <= 0x39; }

  function StopParsing(msg) { this.message = msg; }

  function W2DParser(bytes, opts) {
    this.b = bytes;
    this.p = 0;
    this.opts = opts || {};
    this.version = 0;
    this.items = [];
    this.warnings = [];
    this.layers = {};          // número → nombre
    this.layerOrder = [];
    this.macros = {};
    this.background = null;
    this.view = null;
    this.textCount = 0;
    this.meta = {};
    this.bounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.unsupported = {};
    // Estado de representación ("rendition")
    this.cx = 0; this.cy = 0;
    this.colorMap = null;
    this.color = 0x000000ff;
    this.colorSet = true;
    this.fill = false;
    this.visible = true;
    this.weight = 0;
    this.pattern = 1;
    this.layer = 0;
    this.font = { name: 'Arial', bold: false, italic: false, underline: false, height: 256, rotation: 0, widthScale: 1024, spacing: 1024, oblique: 0 };
    this.halign = 0; this.valign = 0;
    this.macroIndex = 0; this.macroScale = 1;
    this.node = 0;
    this.inMacro = 0;
  }

  var P = W2DParser.prototype;

  P.u8 = function () { return this.b[this.p++]; };
  P.u16 = function () { var b = this.b, p = this.p; this.p = p + 2; return b[p] | (b[p + 1] << 8); };
  P.i16 = function () { var v = this.u16(); return v & 0x8000 ? v - 0x10000 : v; };
  P.i32 = function () { var b = this.b, p = this.p; this.p = p + 4; return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); };
  P.count = function () { var c = this.b[this.p++]; return c !== 0 ? c : 256 + this.u16(); };
  P.need = function (n) { if (this.p + n > this.b.length) throw new StopParsing('El flujo de datos termina antes de lo esperado.'); };
  P.eatWs = function () { var b = this.b, n = b.length; while (this.p < n && isWs(b[this.p])) this.p++; };

  P.asciiInt = function () {
    var b = this.b;
    this.eatWs();
    var sign = 1, c = b[this.p];
    if (c === 0x2d) { sign = -1; this.p++; } else if (c === 0x2b) this.p++;
    this.eatWs();
    if (!isDigit(b[this.p])) throw new StopParsing('Se esperaba un número en la posición ' + this.p + '.');
    var v = 0;
    while (isDigit(b[this.p])) v = v * 10 + (b[this.p++] - 0x30);
    return sign * v;
  };
  P.asciiDouble = function () {
    var b = this.b;
    this.eatWs();
    var s = this.p;
    var c = b[this.p];
    if (c === 0x2d || c === 0x2b) this.p++;
    while (this.p < b.length) {
      c = b[this.p];
      if (isDigit(c) || c === 0x2e || c === 0x65 || c === 0x45) this.p++;
      else if ((c === 0x2d || c === 0x2b) && (b[this.p - 1] === 0x65 || b[this.p - 1] === 0x45)) this.p++;
      else break;
    }
    var str = ''; for (var i = s; i < this.p; i++) str += String.fromCharCode(b[i]);
    var v = parseFloat(str);
    if (isNaN(v)) throw new StopParsing('Se esperaba un número decimal en la posición ' + s + '.');
    return v;
  };
  P.expect = function (ch) {
    if (this.b[this.p] !== ch) throw new StopParsing('Se esperaba "' + String.fromCharCode(ch) + '" en la posición ' + this.p + '.');
    this.p++;
  };
  /** Punto ASCII "x,y" → guarda en this.ax / this.ay */
  P.asciiPoint = function () {
    this.ax = this.asciiInt();
    this.expect(0x2c);
    this.ay = this.asciiInt();
  };

  /** Cadena cruda (WT_File::read(char*&)): devuelve {bytes, quote} */
  P.rawString = function () {
    var b = this.b, n = b.length;
    this.eatWs();
    var out = [], c = b[this.p], quote = 0;
    if (c === 0x27 || c === 0x22) {
      quote = c; this.p++;
      while (this.p < n) {
        c = b[this.p++];
        if (c === 0x5c) { out.push(b[this.p++]); continue; }
        if (c === quote) break;
        out.push(c);
      }
    } else {
      while (this.p < n) {
        c = b[this.p];
        if (c === 0x29 || isWs(c)) break;
        this.p++;
        if (c === 0x5c) { out.push(b[this.p++]); continue; }
        out.push(c);
      }
    }
    return { bytes: out, quote: quote };
  };
  P.decodeRaw = function (r) {
    var bytes = r.bytes, s = '', i;
    if (r.quote === 0x22) {
      for (i = 0; i + 3 < bytes.length; i += 4) {
        var h = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
        var v = parseInt(h, 16);
        // El toolkit guarda cada unidad UTF-16 con los bytes intercambiados.
        s += String.fromCharCode(((v & 0xff) << 8) | (v >> 8));
      }
      return s;
    }
    return decodeBytes(new Uint8Array(bytes));
  };
  /** WT_String::materialize */
  P.string = function () {
    this.eatWs();
    if (this.b[this.p] === 0x7b) {
      this.p++;
      var len = this.i32();
      if (len < 0 || this.p + len * 2 > this.b.length) throw new StopParsing('Cadena de texto dañada.');
      var s = '', b = this.b, p = this.p;
      for (var i = 0; i < len; i++, p += 2) s += String.fromCharCode(b[p] | (b[p + 1] << 8));
      this.p = p;
      this.expect(0x7d);
      return s;
    }
    return this.decodeRaw(this.rawString());
  };
  P.word = function () { return decodeBytes(new Uint8Array(this.rawString().bytes)); };

  /** Avanza hasta después del ')' que cierra el nivel actual. */
  P.skipParen = function () {
    var b = this.b, n = b.length, depth = 1, inStr = false;
    while (this.p < n) {
      var c = b[this.p++];
      if (c === 0x5c) { this.p++; continue; }
      if (c === 0x27) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === 0x28) depth++;
      else if (c === 0x29) { if (--depth === 0) return; }
      else if (c === 0x7b) {
        // Bloque binario: normalmente una cadena UTF-16 de "cnt" caracteres (2 bytes c/u).
        var cnt = this.i32();
        if (cnt > 0) {
          if (b[this.p + cnt * 2] === 0x7d) this.p += cnt * 2 + 1;
          else this.p += cnt;
        }
      }
    }
  };
  P.token = function () {
    var b = this.b, s = '';
    while (this.p < b.length) {
      var c = b[this.p];
      if (c >= 0x21 && c <= 0x7a && c !== 0x28 && c !== 0x29) { s += String.fromCharCode(c); this.p++; }
      else break;
    }
    return s;
  };

  // ── Punto actual (coordenadas relativas) ──
  P.rel16 = function () { this.cx = (this.cx + this.i16()) | 0; this.cy = (this.cy + this.i16()) | 0; };
  P.rel32 = function () { this.cx = (this.cx + this.i32()) | 0; this.cy = (this.cy + this.i32()) | 0; };

  P.pointsBin = function (n, is16) {
    this.need(n * (is16 ? 4 : 8));
    var pts = new Array(n * 2), b = this.b, p = this.p, x = this.cx, y = this.cy, i, v;
    if (is16) {
      for (i = 0; i < n * 2; i += 2, p += 4) {
        v = b[p] | (b[p + 1] << 8); x = (x + (v & 0x8000 ? v - 0x10000 : v)) | 0;
        v = b[p + 2] | (b[p + 3] << 8); y = (y + (v & 0x8000 ? v - 0x10000 : v)) | 0;
        pts[i] = x; pts[i + 1] = y;
      }
    } else {
      for (i = 0; i < n * 2; i += 2, p += 8) {
        x = (x + (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24))) | 0;
        y = (y + (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24))) | 0;
        pts[i] = x; pts[i + 1] = y;
      }
    }
    this.p = p; this.cx = x; this.cy = y;
    return pts;
  };
  P.pointsAscii = function (n) {
    var pts = new Array(n * 2);
    for (var i = 0; i < n; i++) { this.asciiPoint(); pts[i * 2] = this.ax; pts[i * 2 + 1] = this.ay; }
    return pts;
  };
  P.pointSet = function (mode) {
    if (mode === 0) { var n = this.asciiInt(); if (n < 1) throw new StopParsing('Conjunto de puntos inválido.'); return this.pointsAscii(n); }
    return this.pointsBin(this.count(), mode === 16);
  };

  // ── Color ──
  P.palette = function () {
    if (!this.colorMap) {
      var src = this.version && this.version < 38 ? TABLES.oldPalette : TABLES.newPalette;
      var m = new Array(256);
      for (var i = 0; i < 256; i++) m[i] = ((src[i * 4] << 24) | (src[i * 4 + 1] << 16) | (src[i * 4 + 2] << 8) | src[i * 4 + 3]) >>> 0;
      this.colorMap = m;
    }
    return this.colorMap;
  };
  P.rgbaBin = function () {
    var b = this.b, p = this.p; this.p += 4;
    if (this.version && this.version < 33) return ((b[p + 2] << 24) | (b[p + 1] << 16) | (b[p] << 8) | b[p + 3]) >>> 0;
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  };
  P.fromIndex = function (i) { var m = this.palette(); return i >= 0 && i < m.length ? m[i] : 0; };
  /** Color ASCII: "r,g,b,a" o índice */
  P.asciiColor = function () {
    var v = this.asciiInt();
    if (this.b[this.p] === 0x2c) {
      this.p++; var g = this.asciiInt(); this.expect(0x2c);
      var bl = this.asciiInt(); this.expect(0x2c);
      var a = this.asciiInt();
      return (((v & 255) << 24) | ((g & 255) << 16) | ((bl & 255) << 8) | (a & 255)) >>> 0;
    }
    return this.fromIndex(v);
  };
  P.setColor = function (c) { this.color = c; this.colorSet = true; };
  P.readColorMap = function (binary) {
    var n, m, i;
    if (binary) {
      n = this.u8(); if (n === 0) n = 256;
      m = new Array(n);
      for (i = 0; i < n; i++) m[i] = this.rgbaBin();
    } else {
      n = this.asciiInt();
      if (n < 0 || n > 65535) throw new StopParsing('Mapa de colores inválido.');
      m = new Array(n);
      for (i = 0; i < n; i++) m[i] = this.asciiColor.call(this);
    }
    return m;
  };

  // ── Emisión de elementos ──
  P.emit = function (it, x0, y0, x1, y1) {
    if (!this.visible && !this.inMacro) return;
    it.c = (this.inMacro && !this.colorSet) ? null : this.color;
    it.L = this.layer;
    it.bb = [x0, y0, x1, y1];
    this.items.push(it);
    if (!this.inMacro) {
      var B = this.bounds;
      if (x0 < B[0]) B[0] = x0; if (y0 < B[1]) B[1] = y0;
      if (x1 > B[2]) B[2] = x1; if (y1 > B[3]) B[3] = y1;
    }
  };
  P.emitPts = function (kind, pts, extra) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i += 2) {
      var x = pts[i], y = pts[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    var it = { k: kind, pts: pts };
    if (kind === 'l') { it.w = this.weight; it.d = this.pattern; }
    if (extra) for (var key in extra) it[key] = extra[key];
    var pad = kind === 'l' ? this.weight / 2 : 0;
    this.emit(it, x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  };
  P.polyline = function (pts) { this.emitPts(this.fill ? 'g' : 'l', pts); };
  P.ellipse = function (x, y, major, minor, start, end, tilt) {
    if (this.version && this.version <= 30) {
      if (start !== end && end < 0x10000) end++;
    }
    if (end <= start) end += 0x10000;
    var r = Math.max(Math.abs(major), Math.abs(minor)) + this.weight / 2;
    this.emit({ k: 'e', x: x, y: y, a: major, b: minor, s: start, e: end, t: tilt, f: this.fill, w: this.weight, d: this.pattern },
      x - r, y - r, x + r, y + r);
  };
  P.text = function (x, y, str, bounds) {
    if (!str) return;
    var f = this.font, h = Math.abs(f.height) || 1;
    var x0, y0, x1, y1;
    if (bounds) {
      x0 = Math.min(bounds[0], bounds[2], bounds[4], bounds[6]); x1 = Math.max(bounds[0], bounds[2], bounds[4], bounds[6]);
      y0 = Math.min(bounds[1], bounds[3], bounds[5], bounds[7]); y1 = Math.max(bounds[1], bounds[3], bounds[5], bounds[7]);
    } else {
      var r = h * (str.length * 0.7 + 1);
      x0 = x - r; y0 = y - r; x1 = x + r; y1 = y + r;
    }
    this.textCount++;
    this.emit({ k: 'x', x: x, y: y, s: str, f: f, bd: bounds || null, ha: this.halign, va: this.valign }, x0, y0, x1, y1);
  };
  P.newFont = function () {
    var o = this.font, f = {};
    for (var k in o) f[k] = o[k];
    this.font = f;
    return f;
  };
  P.setLayer = function (num, name) {
    this.layer = num;
    if (!(num in this.layers)) { this.layers[num] = name || ('Capa ' + num); this.layerOrder.push(num); }
    else if (name) this.layers[num] = name;
  };
  P.unsup = function (what) { this.unsupported[what] = (this.unsupported[what] || 0) + 1; };

  // ── Cabecera ──
  P.header = function () {
    var b = this.b;
    if (b.length < 12) throw new Error('El archivo es demasiado corto para ser un DWF.');
    var head = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (head !== '(DWF V' && head !== '(W2D V') throw new Error('No es un flujo DWF/W2D válido.');
    var v = String.fromCharCode(b[6], b[7], b[8], b[9], b[10]);
    if (!/^\d\d\.\d\d$/.test(v) || b[11] !== 0x29) throw new Error('Cabecera DWF dañada.');
    this.version = parseInt(v.substr(0, 2), 10) * 100 + parseInt(v.substr(3, 2), 10);
    this.versionText = v;
    this.p = 12;
  };

  // ── Bucle principal ──
  P.parse = function () {
    this.header();
    try {
      this.run(false);
    } catch (e) {
      if (e instanceof StopParsing) this.warnings.push(e.message + ' Se muestra lo que se pudo leer.');
      else if (e instanceof RangeError || e instanceof TypeError) this.warnings.push('Datos dañados (' + e.message + '). Se muestra lo que se pudo leer.');
      else throw e;
    }
    return this;
  };

  P.run = function (untilParen) {
    var b;
    for (;;) {
      this.eatWs();
      b = this.b;
      if (this.p >= b.length) return;
      var c = b[this.p++];
      if (c === 0x28) {
        if (this.extAscii(this.token()) === false) return;
      } else if (c === 0x7b) {
        this.need(6);
        var size = this.i32(), op = this.u16();
        if (op === 0x0010 || op === 0x0011 || op === 0x0123) { this.decompress(op); continue; }
        var end = this.p - 2 + size;
        if (size < 3 || end > b.length) throw new StopParsing('Bloque binario con tamaño inválido.');
        this.extBinary(op, end);
        this.p = end;
      } else if (c === 0x29 && untilParen) {
        return;
      } else {
        this.single(c);
      }
    }
  };

  P.decompress = function (op) {
    var b = this.b, r;
    if (op === 0x0011) {
      var dict = this._dict || (this._dict = new Uint8Array(TABLES.preload.slice(0, TABLES.preload.length - 2048)));
      try { r = inflateZlib(b, this.p, dict); }
      catch (e) { throw new StopParsing('No se pudo descomprimir el dibujo (' + e.message + ').'); }
    } else {
      r = this.lzDecompress(b, this.p);
    }
    var rest = r.pos;
    if (b[rest] === 0x7d) rest++;
    var tail = b.subarray(Math.min(rest, b.length));
    var nb = new Uint8Array(r.out.length + tail.length);
    nb.set(r.out, 0); nb.set(tail, r.out.length);
    this.b = nb; this.p = 0;
  };

  /** Compresión LZ propia de versiones antiguas (anteriores a zlib). */
  P.lzDecompress = function (src, pos) {
    var preloaded = this.version >= 23;
    var pre = preloaded ? TABLES.preload.length - 1 : 0;
    var cap = Math.max(4096, (src.length - pos) * 6) + pre, out = new Uint8Array(cap), op = 0;
    if (preloaded) { out.set(TABLES.preload.slice(0, pre), 0); op = pre; }
    var n = src.length;
    function grow(need) { var m = cap; while (m < need) m *= 2; var o = new Uint8Array(m); o.set(out.subarray(0, op)); out = o; cap = m; }
    while (pos < n) {
      var code = src[pos++];
      if (!code) break;
      var lit = code & 15, run = code >> 4;
      if (lit === 15) lit += src[pos++];
      if (lit) {
        if (op + lit > cap) grow(op + lit);
        out.set(src.subarray(pos, pos + lit), op); op += lit; pos += lit;
      }
      if (!run) continue;
      if (run === 15) run += src[pos++];
      run += 3;
      var off = src[pos] | (src[pos + 1] << 8); pos += 2;
      var winStart = Math.max(0, op - 65536), winSize = op - winStart;
      var from = preloaded ? winStart + (winSize - 1) - off : winStart + off;
      if (from < 0) throw new StopParsing('Datos comprimidos (LZ) dañados.');
      if (op + run > cap) grow(op + run);
      while (run--) out[op++] = out[from++];
    }
    return { out: out.subarray(pre, op), pos: pos };
  };

  // ── Códigos de un byte ──
  P.single = function (c) {
    var pts, n, x, y, r, i;
    switch (c) {
      case 0x0c: this.need(8); this.polylineSeg(this.pointsBin(2, true)); break;
      case 0x6c: this.need(16); this.polylineSeg(this.pointsBin(2, false)); break;
      case 0x4c: this.polylineSeg(this.pointsAscii(2)); break;
      case 0x10: this.polyline(this.pointSet(16)); break;
      case 0x70: this.polyline(this.pointSet(32)); break;
      case 0x50: this.polyline(this.pointSet(0)); break;
      case 0x14: this.emitPts('t', this.pointSet(16)); break;
      case 0x74: this.emitPts('t', this.pointSet(32)); break;
      case 0x54: this.emitPts('t', this.pointSet(0)); break;

      case 0x12: this.need(6); this.rel16(); r = this.u16(); this.ellipse(this.cx, this.cy, r, r, 0, 0x10000, 0); break;
      case 0x72: this.need(12); this.rel32(); r = this.i32(); this.ellipse(this.cx, this.cy, r, r, 0, 0x10000, 0); break;
      case 0x52: this.asciiPoint(); x = this.ax; y = this.ay; r = this.asciiInt(); this.ellipse(x, y, r, r, 0, 0x10000, 0); break;
      case 0x92: {
        this.need(16); this.rel32(); r = this.i32(); var s = this.u16(), e = this.u16();
        this.ellipse(this.cx, this.cy, r, r, s, e, 0); break;
      }
      case 0x65: {
        this.need(22);
        var dx = this.i32(), dy = this.i32(), ma = this.i32(), mi = this.i32(), st = this.u16(), en = this.u16(), tl = this.u16();
        this.cx = (this.cx + dx) | 0; this.cy = (this.cy + dy) | 0;
        this.ellipse(this.cx, this.cy, ma, mi, st, en, tl); break;
      }
      case 0x45: {
        this.asciiPoint(); x = this.ax; y = this.ay; this.asciiPoint();
        this.ellipse(x, y, this.ax, this.ay, 0, 0x10000, 0); break;
      }

      case 0x0b: this.contour(true); break;
      case 0x6b: this.contour(false); break;

      case 0x07: this.gouraud(true, 't'); break;
      case 0x67: this.gouraud(false, 't'); break;
      case 0x11: this.gouraud(true, 'l'); break;
      case 0x71: this.gouraud(false, 'l'); break;

      case 0x03: this.need(4); this.setColor(this.rgbaBin()); break;
      case 0x63: this.setColor(this.fromIndex(this.u8())); break;
      case 0x43: this.setColor(this.fromIndex(this.asciiInt())); break;
      case 0x46: this.fill = true; break;
      case 0x66: this.fill = false; break;
      case 0x56: this.visible = true; break;
      case 0x76: this.visible = false; break;
      case 0x17: this.need(4); this.weight = Math.max(0, this.i32()); break;
      case 0xac: this.setLayer(this.count()); break;
      case 0xcc: this.pattern = this.count(); break;
      case 0x4f: this.need(8); this.cx = this.i32(); this.cy = this.i32(); break;
      case 0x4e: this.need(4); this.node = this.i32(); break;
      case 0x6e: this.need(2); this.node += this.i16(); break;
      case 0x0e: this.node++; break;
      case 0x06: this.fontBinary(); break;

      case 0x78: { // texto básico
        this.need(8); this.rel32(); x = this.cx; y = this.cy;
        this.text(x, y, this.string(), null); break;
      }
      case 0x18: { // texto complejo
        if (this.version < 32) throw new StopParsing('Formato de texto obsoleto no soportado.');
        this.need(8); this.rel32(); x = this.cx; y = this.cy;
        var str = this.string();
        n = this.count() - 1; for (i = 0; i < n; i++) this.count();   // sobrerrayado
        n = this.count() - 1; for (i = 0; i < n; i++) this.count();   // subrayado
        var bd = this.pointsBin(4, false);
        if (this.version >= 600) { n = this.count() - 1; for (i = 0; i < n; i++) this.count(); }
        var empty = true; for (i = 2; i < 8; i++) if (bd[i] !== bd[i & 1]) { empty = false; break; }
        this.text(x, y, str, empty ? null : bd); break;
      }

      case 0x47: // 'G' índice de macro / símbolo de marcador
        this.macroIndex = this.asciiInt(); break;
      case 0x53: this.macroScale = this.asciiInt(); break;
      case 0x73: this.need(4); this.macroScale = this.i32(); break;
      case 0x8d: this.macroDraw(this.pointSet(16)); break;
      case 0x6d: this.macroDraw(this.pointSet(32)); break;
      case 0x4d: this.macroDraw(this.pointSet(0)); break;

      default:
        throw new StopParsing('Código de dibujo no reconocido (0x' + c.toString(16) + ') en la posición ' + (this.p - 1) + '.');
    }
  };
  P.polylineSeg = function (pts) { this.emitPts('l', pts); };

  P.contour = function (is16) {
    var n = this.count(), counts = new Array(n), total = 0, i;
    for (i = 0; i < n; i++) { counts[i] = this.count(); total += counts[i]; }
    var pts = this.pointsBin(total, is16);
    this.emitPts('c', pts, { n: counts });
  };
  P.gouraud = function (is16, kind) {
    var n = this.count(), pts = new Array(n * 2), cols = new Array(n);
    this.need(n * (is16 ? 8 : 12));
    for (var i = 0; i < n; i++) {
      if (is16) this.rel16(); else this.rel32();
      pts[i * 2] = this.cx; pts[i * 2 + 1] = this.cy;
      cols[i] = this.rgbaBin();
    }
    this.emitPts(kind === 't' ? 'gt' : 'gl', pts, { cols: cols, w: this.weight });
  };
  P.macroDraw = function (pts) {
    if (this.version >= 601) {
      var def = this.macros[this.macroIndex];
      if (!def) { this.unsup('macro sin definir'); return; }
      var k = def.units ? this.macroScale / def.units : 1;
      var bb = def.bb, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i] + bb[0] * k); x1 = Math.max(x1, pts[i] + bb[2] * k);
        y0 = Math.min(y0, pts[i + 1] + bb[1] * k); y1 = Math.max(y1, pts[i + 1] + bb[3] * k);
      }
      if (!isFinite(x0)) return;
      this.emit({ k: 'm', pts: pts, items: def.items, sc: k }, x0, y0, x1, y1);
    } else {
      this.emitPts('p', pts);
    }
  };

  P.fontBinary = function () {
    var f = this.newFont();
    if (this.version < 31) {
      var len = this.count(), nm = '';
      for (var i = 0; i < len; i++) nm += String.fromCharCode(this.u8());
      f.name = nm;
      var bi = this.u8(); f.bold = !!(bi & 1); f.italic = !!(bi & 2);
      this.i32(); this.i32();
      return;
    }
    var fields = this.u16();
    if (fields & 0x0001) f.name = this.string();
    if (fields & 0x0002) this.u8();
    if (fields & 0x0004) this.u8();
    if (fields & 0x0008) this.u8();
    if (fields & 0x0010) { var st = this.u8(); f.bold = !!(st & 1); f.italic = !!(st & 2); f.underline = !!(st & 4); }
    if (fields & 0x0020) f.height = this.i32();
    if (fields & 0x0040) f.rotation = this.u16();
    if (fields & 0x0080) f.widthScale = this.u16();
    if (fields & 0x0100) f.spacing = this.u16();
    if (fields & 0x0200) f.oblique = this.u16();
    if (fields & 0x0400) this.i32();
  };

  // ── Códigos ASCII extendidos "(Nombre ...)" ──
  P.extAscii = function (tok) {
    var x, y, a, b2, i, n;
    switch (tok) {
      case 'EndOfDWF': return false;
      case 'Color': this.setColor(this.asciiColor()); break;
      case 'ColorMap': this.colorMap = this.readColorMap(false); if (this.version < 25) this.background = this.colorMap[0]; break;
      case 'Background': this.background = this.asciiColor(); break;
      case 'LineWeight': this.weight = Math.max(0, this.asciiInt()); break;
      case 'Layer': n = this.asciiInt(); this.setLayer(n, this.string()); break;
      case 'LinePattern': {
        var nm = this.word(), id = LINE_PATTERNS.indexOf(nm);
        this.pattern = id > 0 ? id : 1; break;
      }
      case 'Circle': {
        this.asciiPoint(); x = this.ax; y = this.ay; a = this.asciiInt();
        this.eatWs();
        var s = 0, e = 0x10000;
        if (this.b[this.p] !== 0x29) { this.asciiPoint(); s = this.ax & 0xffff; e = this.ay & 0x1ffff; }
        this.ellipse(x, y, a, a, s, e, 0); break;
      }
      case 'Ellipse': {
        this.asciiPoint(); x = this.ax; y = this.ay; this.asciiPoint(); a = this.ax; b2 = this.ay;
        this.asciiPoint(); var s2 = this.ax & 0xffff, e2 = this.ay & 0x1ffff;
        this.eatWs(); var tilt = this.b[this.p] !== 0x29 ? this.asciiInt() : 0;
        this.ellipse(x, y, a, b2, s2, e2, tilt & 0xffff); break;
      }
      case 'Contour': {
        n = this.asciiInt(); var counts = new Array(n), total = 0;
        for (i = 0; i < n; i++) { counts[i] = this.asciiInt(); total += counts[i]; }
        this.emitPts('c', this.pointsAscii(total), { n: counts }); break;
      }
      case 'Text': this.textAscii(); return;
      case 'Font': this.fontAscii(); return;
      case 'TextHAlign': { var h = this.word(); this.halign = h === 'Center' ? 1 : h === 'Right' ? 2 : 0; break; }
      case 'TextVAlign': { var v = this.word(); this.valign = ({ Descentline: 0, Baseline: 1, Halfline: 2, Capline: 3, Ascentline: 4 })[v]; if (this.valign === undefined) this.valign = 1; break; }
      case 'View': {
        this.eatWs();
        if (isDigit(this.b[this.p]) || this.b[this.p] === 0x2d) {
          this.asciiPoint(); x = this.ax; y = this.ay; this.asciiPoint();
          this.view = [Math.min(x, this.ax), Math.min(y, this.ay), Math.max(x, this.ax), Math.max(y, this.ay)];
        }
        break;
      }
      case 'Macro': {
        var idx = this.asciiInt(), units = this.asciiInt();
        var saved = { items: this.items, fill: this.fill, colorSet: this.colorSet, color: this.color, weight: this.weight, cx: this.cx, cy: this.cy, visible: this.visible };
        this.items = []; this.fill = false; this.colorSet = false; this.inMacro++;
        try { this.run(true); }
        finally {
          var items = this.items;
          this.items = saved.items; this.inMacro--;
          this.fill = saved.fill; this.colorSet = saved.colorSet; this.color = saved.color; this.weight = saved.weight;
          var bb = [Infinity, Infinity, -Infinity, -Infinity];
          for (i = 0; i < items.length; i++) {
            var q = items[i].bb;
            if (q[0] < bb[0]) bb[0] = q[0]; if (q[1] < bb[1]) bb[1] = q[1];
            if (q[2] > bb[2]) bb[2] = q[2]; if (q[3] > bb[3]) bb[3] = q[3];
          }
          this.macros[idx] = { items: items, units: units, bb: bb };
        }
        return;
      }
      case 'Node': this.node = this.asciiInt(); break;
      case 'Author': case 'Creator': case 'Title': case 'Subject': case 'Description': case 'Comments':
      case 'Keywords': case 'Copyright': case 'SourceFilename':
        try { this.meta[tok] = this.string(); } catch (e) { /* metadato opcional */ }
        break;
      case 'Image': case 'Group4PNGImage': this.unsup('imagen en formato de texto'); break;
      case 'Gouraud': case 'GourLine': this.unsup('sombreado en formato de texto'); break;
      case 'Bezier': this.unsup('curva Bézier'); break;
      default: break;
    }
    this.skipParen();
  };

  P.textAscii = function () {
    this.asciiPoint();
    var x = this.ax, y = this.ay, str = this.string(), bounds = null;
    for (;;) {
      this.eatWs();
      var c = this.b[this.p];
      if (c === 0x28) {
        this.p++;
        var t = this.token();
        if (t === 'Bounds') bounds = this.pointsAscii(4);
        this.skipParen();
      } else break;
    }
    this.skipParen();
    this.text(x, y, str, bounds);
  };

  P.fontAscii = function () {
    var f = this.newFont();
    for (;;) {
      this.eatWs();
      if (this.b[this.p] !== 0x28) break;
      this.p++;
      var t = this.token();
      switch (t) {
        case 'Name': f.name = this.string(); break;
        case 'Height': f.height = this.asciiInt(); break;
        case 'Rotation': f.rotation = this.asciiInt() & 0xffff; break;
        case 'Widthscale': f.widthScale = this.asciiInt(); break;
        case 'Spacing': f.spacing = this.asciiInt(); break;
        case 'Oblique': f.oblique = this.asciiInt(); break;
        case 'Style': {
          var s = this.p; this.skipParen();
          var txt = decodeBytes(this.b.subarray(s, this.p)).toLowerCase();
          f.bold = txt.indexOf('bold') >= 0; f.italic = txt.indexOf('italic') >= 0; f.underline = txt.indexOf('underline') >= 0;
          continue;
        }
        default: break;
      }
      this.skipParen();
    }
    this.skipParen();
  };

  // ── Códigos binarios extendidos "{tamaño código datos}" ──
  P.extBinary = function (op, end) {
    switch (op) {
      case 0x0001: this.colorMap = this.readColorMap(true); break;
      case 0x0002: case 0x0003: case 0x0004: case 0x0005: case 0x0006: case 0x0007: case 0x0008:
      case 0x0009: case 0x000c: case 0x000d:
        this.image(op, end); break;
      case 371: { var h = this.u8(); this.halign = h < 3 ? h : 0; break; }
      case 373: { var v = this.u8(); this.valign = v < 5 ? v : 1; break; }
      default: break;
    }
  };

  P.image = function (op, end) {
    var cols = this.u16(), rows = this.u16();
    this.rel32(); var x0 = this.cx, y0 = this.cy;
    this.rel32(); var x1 = this.cx, y1 = this.cy;
    this.i32(); // identificador
    var cmap = null;
    if (op === 0x0002 || op === 0x0003 || op === 0x0005 || op === 0x000d) cmap = this.readColorMap(true);
    var size = this.i32();
    if (size < 0 || this.p + size > end) { this.unsup('imagen dañada'); return; }
    var data = this.b.slice(this.p, this.p + size);
    var fmt = ({ 4: 'indexed', 5: 'mapped', 6: 'rgb', 7: 'rgba', 8: 'jpeg', 12: 'png' })[op];
    if (!fmt) this.unsup('imagen bitonal (fax grupo 3/4)');
    if (fmt === 'indexed') { cmap = this.palette().slice(); fmt = 'mapped'; }
    this.emit({ k: 'i', fmt: fmt || null, cols: cols, rows: rows, x0: x0, y0: y0, x1: x1, y1: y1, data: fmt ? data : null, cmap: cmap },
      Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
  };

  /**
   * Los planos de AutoCAD suelen usar coordenadas cercanas a 2^31. El canvas trabaja con
   * precisión simple, así que se trasladan a un origen local y se devuelve ese origen.
   */
  function rebase(items, b) {
    var big = Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2]), Math.abs(b[3]));
    if (big < 4e6) return [0, 0];
    var ox = Math.floor((b[0] + b[2]) / 2), oy = Math.floor((b[1] + b[3]) / 2), i, j, q;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      q = it.bb; q[0] -= ox; q[1] -= oy; q[2] -= ox; q[3] -= oy;
      if (it.pts) { q = it.pts; for (j = 0; j < q.length; j += 2) { q[j] -= ox; q[j + 1] -= oy; } }
      if (it.k === 'e' || it.k === 'x') { it.x -= ox; it.y -= oy; }
      if (it.bd) { q = it.bd; for (j = 0; j < 8; j += 2) { q[j] -= ox; q[j + 1] -= oy; } }
      if (it.k === 'i') { it.x0 -= ox; it.x1 -= ox; it.y0 -= oy; it.y1 -= oy; }
    }
    b[0] -= ox; b[1] -= oy; b[2] -= ox; b[3] -= oy;
    return [ox, oy];
  }

  function parseW2D(bytes, opts) {
    var p = new W2DParser(bytes, opts).parse();
    var origin = isFinite(p.bounds[0]) ? rebase(p.items, p.bounds) : [0, 0];
    var layers = p.layerOrder.map(function (n) { return { id: n, name: p.layers[n] }; });
    var b = p.bounds;
    return {
      version: p.versionText, items: p.items, layers: layers, warnings: p.warnings, unsupported: p.unsupported,
      background: p.background, view: p.view, meta: p.meta, textCount: p.textCount, origin: origin,
      bounds: isFinite(b[0]) ? b : null
    };
  }

  // ───────────────────────────── Paquete DWF ─────────────────────────────

  function xmlDecode(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e] || m;
    });
  }
  function attrs(tag) {
    var o = {}, re = /([\w.\-]+:)?([\w.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(tag))) o[m[2]] = xmlDecode(m[4] !== undefined ? m[4] : m[5]);
    return o;
  }
  function elements(xml, name) {
    var re = new RegExp('<(?:[\\w.\\-]+:)?' + name + '\\b([^>]*?)(/?)>', 'g'), out = [], m;
    while ((m = re.exec(xml))) out.push({ attrs: attrs(m[1]), index: m.index, end: re.lastIndex, selfClosing: m[2] === '/' });
    return out;
  }
  function nums(s) { return String(s || '').trim().split(/[\s,]+/).map(Number).filter(function (v) { return !isNaN(v); }); }

  function isZipAt(b, p) { return b[p] === 0x50 && b[p + 1] === 0x4b && (b[p + 2] === 3 || b[p + 2] === 5) && (b[p + 3] === 4 || b[p + 3] === 6); }

  /**
   * Abre un archivo DWF. Devuelve { kind, sheets[], properties, loadSheet(i) }.
   */
  function openDWF(bytes, fileName) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var head = ''; for (var i = 0; i < Math.min(12, bytes.length); i++) head += String.fromCharCode(bytes[i]);
    var isZip = isZipAt(bytes, 0) || (/^\(DWF V/.test(head) && isZipAt(bytes, 12));

    if (!isZip) {
      if (/^\((DWF|W2D) V\d\d\.\d\d\)/.test(head)) {
        var title = (fileName || 'Dibujo').replace(/\.[^.]+$/, '');
        return {
          kind: 'stream', version: head.slice(6, 11), properties: {},
          sheets: [{ title: title, kind: '2d', paper: null }],
          loadSheet: function () {
            var w = parseW2D(bytes);
            return finishSheet({ title: title, paper: null }, [{ data: w, m: [1, 0, 0, 1, 0, 0], role: 'principal' }]);
          }
        };
      }
      throw new Error('El archivo no parece ser un DWF. (Los primeros bytes no corresponden al formato.)');
    }

    var zip = new Zip(bytes);
    var hasXps = zip.entries.some(function (e) { return /\.fpage$|FixedDocumentSequence|\[Content_Types\]\.xml/i.test(e.name); });
    var manifest = zip.readText('manifest.xml');
    var sheets = [], props = {};

    if (manifest) {
      elements(manifest.split(/<(?:[\w.\-]+:)?Sections\b/)[0], 'Property').forEach(function (e) { if (e.attrs.name) props[e.attrs.name] = e.attrs.value || ''; });
      var secRe = /<(?:[\w.\-]+:)?Section\b([^>]*)>([\s\S]*?)<\/(?:[\w.\-]+:)?Section>/g, m;
      while ((m = secRe.exec(manifest))) {
        var sa = attrs(m[1]), body = m[2];
        var res = elements(body, 'Resource').map(function (e) { return e.attrs; });
        sheets.push(describeSection(zip, sa, res));
      }
    }
    if (!sheets.length) {
      zip.entries.filter(function (e) { return /\.w2d$/i.test(e.name); }).forEach(function (e, k) {
        sheets.push({ title: 'Hoja ' + (k + 1), kind: '2d', paper: null, graphics: [{ href: e.name, m: [1, 0, 0, 1, 0, 0], role: '2d streaming graphics' }] });
      });
    }
    if (!sheets.length) {
      if (hasXps) throw new Error('Este archivo es un DWFx (formato XPS), que este visor todavía no soporta. Solo se admiten archivos .dwf.');
      throw new Error('El paquete DWF no contiene hojas de dibujo 2D.');
    }
    sheets = sheets.filter(function (s) { return s.kind === '2d' || s.kind === '3d'; });
    if (!sheets.length) throw new Error('El paquete DWF no contiene hojas de dibujo.');
    sheets.forEach(function (s, k) { s._k = k; });
    sheets.sort(function (a, b) { return ((a.order || 0) - (b.order || 0)) || (a._k - b._k); });

    return {
      kind: 'package', version: head.slice(6, 11), properties: props, sheets: sheets, zip: zip,
      loadSheet: function (idx) {
        var s = sheets[idx];
        if (s.kind !== '2d') return finishSheet(s, []);
        var layers = [];
        s.graphics.forEach(function (g) {
          var data = zip.read(g.href);
          if (!data) return;
          if (g.raster) { layers.push({ raster: { data: data.slice(), mime: g.mime }, m: g.m, role: g.role, extents: g.extents }); return; }
          layers.push({ data: parseW2D(data), m: g.m, role: g.role, clip: g.clip || null });
        });
        return finishSheet(s, layers);
      },
      thumbnail: function (idx) {
        var s = sheets[idx];
        if (!s || !s.thumb) return null;
        try { var d = zip.read(s.thumb.href); return d ? { data: d.slice(), mime: s.thumb.mime || 'image/png' } : null; } catch (e) { return null; }
      }
    };
  }

  function describeSection(zip, sa, tocRes) {
    var type = sa.type || '', name = sa.name || '';
    var sheet = { title: sa.title || name || 'Hoja', kind: /eplot/i.test(type) ? '2d' : (/emodel/i.test(type) && tocRes.some(function (r) { return /3d|w3d|hsf/i.test((r.role || '') + (r.mime || '') + (r.href || '')); })) ? '3d' : 'otro', paper: null, graphics: [], props: {}, order: 0 };
    var descRef = null;
    tocRes.forEach(function (r) { if (/descriptor/i.test(r.role || '')) descRef = r.href; });
    var desc = zip.readText(descRef || (name + '/descriptor.xml'));
    var resList = tocRes;
    if (desc) {
      var page = elements(desc, 'Page')[0] || elements(desc, 'Space')[0];
      if (page) {
        if (!sa.title && page.attrs.name) sheet.title = page.attrs.name;
        if (page.attrs.plotOrder) sheet.order = parseFloat(page.attrs.plotOrder) || 0;
      }
      var paper = elements(desc, 'Paper')[0];
      if (paper) {
        var pa = paper.attrs, w = parseFloat(pa.width), h = parseFloat(pa.height);
        if (w > 0 && h > 0) {
          var col = nums(pa.color), clip = nums(pa.clip);
          sheet.paper = { width: w, height: h, units: pa.units || 'in', color: col.length >= 3 ? col.slice(0, 3) : [255, 255, 255], clip: clip.length === 4 ? clip : null, show: pa.show !== 'false' };
        }
      }
      elements(desc, 'Property').forEach(function (e) { if (e.attrs.name && e.attrs.category !== 'hidden') sheet.props[e.attrs.name] = e.attrs.value || ''; });
      var all = elements(desc, '(?:Graphic|Image|Font)?Resource').map(function (e) { return e.attrs; });
      if (all.length) resList = all;
    }
    resList.forEach(function (r) {
      var role = (r.role || '').toLowerCase(), mime = (r.mime || '').toLowerCase(), href = r.href || '';
      if (!href) return;
      var t = nums(r.transform), mtx = t.length === 16 ? [t[0], t[1], t[4], t[5], t[12], t[13]] : [1, 0, 0, 1, 0, 0];
      if (/thumbnail|preview/.test(role)) { if (!sheet.thumb && /^image\//.test(mime)) sheet.thumb = { href: href, mime: mime }; return; }
      if (mime === 'application/x-w2d' || /\.w2d$/i.test(href)) {
        var clip = nums(r.clip);
        sheet.graphics.push({ href: href, m: mtx, role: role, z: parseFloat(r.zOrder) || 0, clip: clip.length === 4 ? clip : null });
      } else if (/^image\/(png|jpeg|jpg|gif|bmp)/.test(mime) && /raster|overlay|2d/.test(role)) {
        sheet.graphics.push({ href: href, m: mtx, role: role, z: parseFloat(r.zOrder) || 0, raster: true, mime: mime, extents: nums(r.extents) });
      }
    });
    // El dibujo principal primero; las marcas de revisión encima.
    sheet.graphics.sort(function (a, b) { return (a.z - b.z) || ((/markup|overlay/.test(a.role) ? 1 : 0) - (/markup|overlay/.test(b.role) ? 1 : 0)); });
    if (sheet.kind === 'otro' && sheet.graphics.length) sheet.kind = '2d';
    if (sheet.kind === '2d' && !sheet.graphics.length) sheet.kind = 'vacía';
    return sheet;
  }

  function finishSheet(s, layers) {
    var warnings = [], unsupported = {};
    layers.forEach(function (l) {
      var o = l.data && l.data.origin;
      if (!o || (!o[0] && !o[1])) return;
      var m = l.m;
      l.m = [m[0], m[1], m[2], m[3], m[4] + o[0] * m[0] + o[1] * m[2], m[5] + o[0] * m[1] + o[1] * m[3]];
      l.data.origin = [0, 0];
    });
    layers.forEach(function (l) {
      if (!l.data) return;
      l.data.warnings.forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });
      for (var k in l.data.unsupported) unsupported[k] = (unsupported[k] || 0) + l.data.unsupported[k];
    });
    // Extensión en coordenadas de "mundo" (unidades de papel, o lógicas si no hay papel)
    var ext = null;
    function add(x, y) {
      if (!ext) ext = [x, y, x, y];
      else { if (x < ext[0]) ext[0] = x; if (y < ext[1]) ext[1] = y; if (x > ext[2]) ext[2] = x; if (y > ext[3]) ext[3] = y; }
    }
    var content = null;
    layers.forEach(function (l) {
      var b = l.data ? l.data.bounds : (l.extents && l.extents.length === 4 ? l.extents : null);
      if (!b) return;
      var m = l.m;
      [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].forEach(function (q) {
        add(q[0] * m[0] + q[1] * m[2] + m[4], q[0] * m[1] + q[1] * m[3] + m[5]);
      });
    });
    content = ext ? ext.slice() : null;
    var paper = s.paper;
    if (paper && content) {
      // Si el contenido no cae sobre el papel, el descriptor no es fiable: se ignora el papel.
      var cw = content[2] - content[0], ch = content[3] - content[1];
      var far = content[2] < -paper.width || content[0] > 2 * paper.width || content[3] < -paper.height || content[1] > 2 * paper.height;
      var tiny = cw < paper.width * 1e-4 && ch < paper.height * 1e-4;
      if (far || tiny) paper = null;
    }
    if (paper) { add(0, 0); add(paper.width, paper.height); }
    return { title: s.title, kind: s.kind || '2d', paper: paper, layers: layers, extent: ext, content: content, warnings: warnings, unsupported: unsupported, props: s.props || {} };
  }

  var api = {
    openDWF: openDWF, parseW2D: parseW2D, Zip: Zip, inflateRaw: inflateRaw, inflateZlib: inflateZlib,
    DASHES: DASHES, LINE_PATTERNS: LINE_PATTERNS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DWFCore = api;
})(typeof self !== 'undefined' ? self : this);
