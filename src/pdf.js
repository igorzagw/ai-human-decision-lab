/* ============================================================================
   pdf.js — складання PDF просто у браузері, без жодної бібліотеки.

   Навіщо своє. Браузер сам зберегти PDF не вміє: він уміє лише відкрити
   діалог друку, де людина мусить обрати «Зберегти як PDF». Щоб кнопка
   справді віддавала файл, PDF доводиться зібрати байт за байтом.

   Українські літери вимагають вкладеного шрифту: жоден зі стандартних
   шрифтів PDF кирилиці не містить. Тому текст пишеться не літерами, а
   номерами гліфів (Identity-H), а поруч кладеться ToUnicode — завдяки
   їй текст у готовому файлі можна виділити й знайти пошуком.
   ========================================================================== */

'use strict';

const PDF = (() => {

  const A4 = { w: 595.28, h: 841.89 };
  const MARGIN = { top: 56, right: 48, bottom: 56, left: 48 };
  const CONTENT_W = A4.w - MARGIN.left - MARGIN.right;

  const GRAY = { text: [0.08, 0.09, 0.11], muted: [0.35, 0.38, 0.42], faint: [0.55, 0.58, 0.62] };
  const RULE = [0.86, 0.88, 0.90];

  /* ── робота з текстом ────────────────────────────────────────────── */

  /* Пробіли, яких немає у підмножині шрифту, зводимо до звичайного.
     toLocaleString розділяє тисячі нерозривним пробілом, і без цієї заміни
     у PDF на його місці малюється порожній квадратик: «3▯280». */
  const clean = (s) => String(s ?? '').replace(/[     ]/g, ' ');

  /* Символ поза підмножиною позначаємо знаком питання, а не .notdef:
     квадратик виглядає як поломка, а «?» одразу видно, що саме бракує. */
  const gidOf = (ch) => (PDF_FONT.map[ch] ?? PDF_FONT.map['?'] ?? 0);

  /** Ширина рядка в пунктах для заданого кегля. */
  function widthOf(text, size) {
    let w = 0;
    for (const ch of clean(text)) w += PDF_FONT.widths[gidOf(ch)] || 0;
    return (w * size) / 1000;
  }

  /** Текст -> послідовність номерів гліфів у шістнадцятковому вигляді. */
  function hexOf(text) {
    let out = '';
    for (const ch of clean(text)) out += gidOf(ch).toString(16).padStart(4, '0');
    return out;
  }

  /** Розбиття абзацу по ширині: переносимо по словах, довге слово ріжемо. */
  function wrap(text, size, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';

    for (const word of words) {
      const probe = line ? line + ' ' + word : word;
      if (widthOf(probe, size) <= maxWidth) { line = probe; continue; }
      if (line) lines.push(line);

      if (widthOf(word, size) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (widthOf(chunk + ch, size) > maxWidth) { lines.push(chunk); chunk = ''; }
        chunk += ch;
      }
      line = chunk;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /* ── сторінка як потік команд ────────────────────────────────────── */

  function createDoc() {
    const pages = [];
    let ops = [];
    let y = A4.h - MARGIN.top;

    const newPage = () => {
      if (ops.length) pages.push(ops);
      ops = [];
      y = A4.h - MARGIN.top;
    };

    /** Чи лишилось місце під блок висотою h; якщо ні — нова сторінка. */
    const need = (h) => {
      if (y - h < MARGIN.bottom) { newPage(); return true; }
      return false;
    };

    const color = (c) => ops.push(`${c[0]} ${c[1]} ${c[2]} rg`);

    const text = (str, x, size, c = GRAY.text) => {
      color(c);
      ops.push('BT', `/F1 ${size} Tf`, `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
               `<${hexOf(str)}> Tj`, 'ET');
    };

    const rule = (width = CONTENT_W, thickness = 0.6, c = RULE) => {
      ops.push(`${c[0]} ${c[1]} ${c[2]} RG`, `${thickness} w`,
               `${MARGIN.left} ${y.toFixed(2)} m ${(MARGIN.left + width).toFixed(2)} ${y.toFixed(2)} l S`);
    };

    return {
      get y() { return y; },
      set y(v) { y = v; },
      newPage, need, text, rule,
      down: (d) => { y -= d; },
      /** Абзац із переносами. */
      paragraph(str, size, c = GRAY.text, indent = 0, lead = 1.45) {
        const lines = wrap(str, size, CONTENT_W - indent);
        for (const line of lines) {
          need(size * lead);
          text(line, MARGIN.left + indent, size, c);
          y -= size * lead;
        }
      },
      /** Рядок «зліва підпис, справа значення». */
      row(left, right, size = 10) {
        const rightW = widthOf(right, size);
        const leftLines = wrap(left, size, CONTENT_W - rightW - 16);
        need(size * 1.4 * leftLines.length + 6);

        leftLines.forEach((line, i) => {
          text(line, MARGIN.left, size, GRAY.muted);
          if (i === 0) {
            color(GRAY.text);
            ops.push('BT', `/F1 ${size} Tf`,
                     `1 0 0 1 ${(A4.w - MARGIN.right - rightW).toFixed(2)} ${y.toFixed(2)} Tm`,
                     `<${hexOf(right)}> Tj`, 'ET');
          }
          y -= size * 1.4;
        });
        y -= 3;
        rule();
        y -= 7;
      },
      finish() { if (ops.length) pages.push(ops); return pages; },
    };
  }

  /* ── збирання файлу ──────────────────────────────────────────────── */

  const enc = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  };

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /** Відповідність «гліф -> символ», щоб текст у PDF можна було копіювати. */
  function toUnicodeCMap() {
    const pairs = Object.entries(PDF_FONT.map)
      .map(([ch, gid]) => `<${gid.toString(16).padStart(4, '0')}> <${
        ch.codePointAt(0).toString(16).padStart(4, '0')}>`);

    const chunks = [];
    for (let i = 0; i < pairs.length; i += 100) {
      const part = pairs.slice(i, i + 100);
      chunks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar`);
    }

    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Identity-H def
/CMapType 2 def
/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  }

  function build(pages) {
    const objects = [];
    const add = (body, binary = null) => { objects.push({ body, binary }); return objects.length; };

    const fontBytes = b64ToBytes(PDF_FONT.data);
    const scale = 1000 / PDF_FONT.unitsPerEm;

    /* Порядок об'єктів фіксований, бо вони посилаються один на одного. */
    const catalogId = 1;
    const pagesId = 2;
    const fontId = 3;
    const cidFontId = 4;
    const descId = 5;
    const fileId = 6;
    const toUniId = 7;
    const firstPageId = 8;

    const pageIds = pages.map((_, i) => firstPageId + i * 2);
    const contentIds = pages.map((_, i) => firstPageId + i * 2 + 1);

    objects[catalogId - 1] = { body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` };
    objects[pagesId - 1] = {
      body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    };

    objects[fontId - 1] = {
      body: `<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H `
          + `/DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUniId} 0 R >>`,
    };

    const widths = PDF_FONT.widths.map((w) => Math.round(w)).join(' ');
    objects[cidFontId - 1] = {
      body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans `
          + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
          + `/FontDescriptor ${descId} 0 R /DW 1000 /W [0 [${widths}]] /CIDToGIDMap /Identity >>`,
    };

    const bbox = PDF_FONT.bbox.map((v) => Math.round(v * scale)).join(' ');
    objects[descId - 1] = {
      body: `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${bbox}] `
          + `/ItalicAngle 0 /Ascent ${Math.round(PDF_FONT.ascent * scale)} `
          + `/Descent ${Math.round(PDF_FONT.descent * scale)} /CapHeight 700 /StemV 80 `
          + `/FontFile2 ${fileId} 0 R >>`,
    };

    objects[fileId - 1] = {
      body: `<< /Length ${fontBytes.length} /Length1 ${fontBytes.length} >>`,
      binary: fontBytes,
    };

    const cmap = toUnicodeCMap();
    objects[toUniId - 1] = { body: `<< /Length ${cmap.length} >>`, binary: enc(cmap) };

    pages.forEach((ops, i) => {
      const stream = ops.join('\n');
      objects[pageIds[i] - 1] = {
        body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] `
            + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`,
      };
      objects[contentIds[i] - 1] = { body: `<< /Length ${stream.length} >>`, binary: enc(stream) };
    });

    /* Складаємо байти й запам'ятовуємо зміщення для таблиці xref. */
    const parts = [];
    let size = 0;
    const push = (bytes) => { parts.push(bytes); size += bytes.length; };

    push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));

    const offsets = [];
    objects.forEach((obj, i) => {
      offsets[i] = size;
      push(enc(`${i + 1} 0 obj\n${obj.body}\n`));
      if (obj.binary) {
        push(enc('stream\n'));
        push(obj.binary);
        push(enc('\nendstream\n'));
      }
      push(enc('endobj\n'));
    });

    const xrefAt = size;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { xref += `${String(o).padStart(10, '0')} 00000 n \n`; });
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`
          + `startxref\n${xrefAt}\n%%EOF\n`;
    push(enc(xref));

    const file = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { file.set(p, at); at += p.length; }
    return file;
  }

  return { createDoc, build, widthOf, wrap, A4, MARGIN, CONTENT_W, GRAY };
})();
