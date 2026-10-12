/* ============================================================================
   io.js — дані всередину і назовні: шаблон, файл, буфер обміну.

   Чому окремий файл, а не частина ui.js: розбір таблиці — це робота з
   форматами, а не з інтерфейсом. Знати треба неприємні дрібниці:

     • Excel української локалі зберігає CSV через «;», а дробові числа
       пише комою: «34,5». Через кому той самий Excel файл не віддає.
     • Google Sheets і Excel копіюють у буфер обміну через ТАБУЛЯЦІЮ,
       а не через кому. Вставка — це завжди TSV.
     • Windows додає на початок файла BOM, і перший заголовок стає
       «﻿Назва» — колонка не впізнається.
     • Розряди люди пишуть пробілом, і цей пробіл буває нерозривним.

   Якби це жило в обробниках подій, знання розповзлося б по ui.js.

   Назовні йдуть два формати, бо відповідають на різні питання:
     CSV  — таблиця, щоб правити в Excel і віддати секретарю громади;
     JSON — уся робота (умови, таблиця, важливості, перевірка), щоб
            переслати колезі й отримати ТОЙ САМИЙ розрахунок.

   Усередині коду такий файл зветься «кейс» — одним словом зручніше. В
   інтерфейсі цього слова немає: людині в громаді воно нічого не каже,
   тому там написано «Зберегти все».
   ========================================================================== */

'use strict';

const IO = (() => {

  /* Excel не читає UTF-8 без BOM: українські назви стають «Ð¨ÐºÐ¾Ð»Ð°». */
  const BOM = '﻿';

  /* Рядок «sep=;» — розширення Excel. Воно вирішує головну проблему
     обміну: на англійській локалі Excel чекає кому, на українській —
     точку з комою, і файл, зроблений для однієї, ламається в іншій.
     Із цим рядком обидві читають правильно. Наш парсер його теж знає. */
  const SEP = ';';
  const SEP_HINT = 'sep=' + SEP;

  /* Десяткова кома, а не точка: інакше український Excel покаже «34.5»
     текстом, вирівняним ліворуч, і з ним не можна буде рахувати. */
  const DEC = ',';

  const CANDIDATES = ['\t', ';', ',', '|'];

  /* ─────────────────────── числа ───────────────────────
     Головна двозначність: «14,500» — це 14,5 чи 14 500? Відповідь
     залежить від поля, і вона вже є в описі сценарію: крок 0,1 означає,
     що дробова частина осмислена (вартість), крок 1 — що ні (люди,
     місця, оцінка 0–10). Тому розділювачі в цілочисельному полі завжди
     розрядні, а в дробовому останній з них — десятковий.
     Вгадувати за виглядом числа було б гірше: «2,500 млн» зустрічається
     так само часто, як «2 500 осіб». */

  function numberFrom(raw, field) {
    let s = String(raw ?? '').trim();
    if (!s) return null;

    const neg = /^-/.test(s);

    /* Пробіли всіх ґатунків — звичайний, нерозривний, вузький, тонкий —
       і апостроф, яким теж розділяють розряди. */
    s = s.replace(/[\s    '’]/g, '');
    /* Усе інше, крім цифр і розділювачів, — одиниці та сміття:
       «34 млн», «≈12», «15 тис. грн». */
    s = s.replace(/[^0-9.,]/g, '');
    if (!s) return null;

    const fractional = (field?.step ?? 1) < 1;
    let n;

    if (!fractional) {
      n = Number(s.replace(/[.,]/g, ''));
    } else {
      const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
      n = dec === -1
        ? Number(s)
        : Number(s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1).replace(/[.,]/g, ''));
    }

    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }

  /** Назовні число має виглядати так, як його чекає Excel людини. */
  function numberOut(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    return String(n).replace('.', DEC);
  }

  const clampField = (n, f) => Math.min(f.max ?? 1e12, Math.max(f.min ?? 0, n));

  /* ─────────────────────── розбір таблиці ─────────────────────── */

  /** Порожні рядки й коментарі наш формат дозволяє: у шаблоні є підказки. */
  const isSkippable = (cells) => {
    const first = String(cells[0] ?? '').trim();
    return cells.every((c) => !String(c ?? '').trim()) || first.startsWith('#');
  };

  /** Який символ тут розділювач. Рахуємо лише поза лапками: назва
   *  «Школа, садок» інакше зробила б кому переможцем у будь-якому файлі. */
  function detectDelimiter(text) {
    const head = text.split(/\r?\n/).slice(0, 5)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^sep=/i.test(l.trim()))
      .join('\n')
      .replace(/"[^"]*"/g, '');
    let best = SEP;
    let seen = 0;
    for (const d of CANDIDATES) {
      const n = head.split(d).length - 1;
      if (n > seen) { seen = n; best = d; }
    }
    return best;
  }

  /** CSV за RFC 4180: лапки захищають розділювач і перенос рядка всередині
   *  поля, подвійні лапки означають одну справжню. */
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
        } else { cell += ch; }
        continue;
      }

      if (ch === '"' && !cell.trim()) { quoted = true; cell = ''; continue; }
      if (ch === delim) { row.push(cell); cell = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    row.push(cell);
    rows.push(row);

    return rows.filter((r) => r.length > 1 || String(r[0] ?? '').trim());
  }

  /* ─────────────────────── заголовки ───────────────────────
     Порівнюємо не рядки, а їхні «скелети»: без регістру, без одиниць
     після коми, без пунктуації і пробілів. Тоді «Вартість, млн»,
     «вартість» і «ВАРТІСТЬ (млн грн)» — те саме поле. */

  const skeleton = (s) => String(s ?? '')
    .replace(/^﻿/, '')
    .split(/[,(]/)[0]
    .toLowerCase()
    .replace(/[\s'’‘.\-–—_/]/g, '');

  /* Слова, якими людина назве колонку інакше, ніж ми. Ключ — поле
     сценарію, значення — як це могли підписати в чужій таблиці. */
  const ALIASES = {
    name:       ['назва', 'обєкт', 'сфера', 'ланка', 'напрям', 'найменування', 'name'],
    type:       ['тип', 'категорія', 'вид'],
    kind:       ['тип', 'галузь', 'категорія', 'вид'],
    cost:       ['вартість', 'ціна', 'кошторис', 'сума', 'cost'],
    served:     ['користувачів', 'людей', 'мешканців', 'охоплення'],
    critical:   ['критичність', 'критично'],
    state:      ['стан'],
    affected:   ['когостосується', 'людей', 'охоплення', 'мешканців'],
    importance: ['важливість', 'пріоритет'],
    capacity:   ['скількохвитримує', 'місткість', 'потужність', 'ємність'],
    vital:      ['наскількинеобхідна', 'необхідність'],
    costUp:     ['цінарозширення', 'розширення'],
    jobs:       ['робочихмісць', 'місць', 'роботи', 'зайнятість'],
    wage:       ['зарплата', 'середнязарплата', 'оплата', 'заробіток'],
  };

  /** Яке поле сценарію стоїть у цій колонці. null — колонка чужа. */
  function matchField(header, fields) {
    const k = skeleton(header);
    if (!k) return null;
    const exact = fields.find((f) => skeleton(f.label) === k || f.key.toLowerCase() === k);
    if (exact) return exact;
    for (const f of fields) {
      const list = ALIASES[f.key] || [];
      if (list.some((a) => k === a || (a.length > 3 && k.startsWith(a)))) return f;
    }
    return null;
  }

  /** Значення випадаючого списку назад у ключ: у файлі стоїть «Школа, садок»
   *  або «🏫 Школа, садок», а нам потрібен 'school'. */
  function optionKey(raw, options) {
    const k = skeleton(raw);
    if (!k) return null;
    const keys = Object.keys(options);
    const direct = keys.find((key) => key.toLowerCase() === String(raw).trim().toLowerCase());
    if (direct) return direct;
    const byLabel = keys.find((key) => skeleton(options[key].label) === k);
    if (byLabel) return byLabel;
    /* Часткове: кому в «Школа, садок» skeleton уже зрізав, тож тут
       ловимо решту — «лікарн» у «Лікарня», «вода» у «Вода». */
    return keys.find((key) => {
      const label = skeleton(options[key].label);
      return label.startsWith(k) || k.startsWith(label);
    }) || null;
  }

  /**
   * Розбір вставленої або завантаженої таблиці.
   * Повертає не лише рядки, а й те, ЩО САМЕ зрозуміло: людина має
   * побачити сопоставлення колонок до того, як дані замінять її роботу.
   */
  function parseItems(text, scenario) {
    const warnings = [];
    const fields = scenario.itemFields;

    let body = String(text ?? '').replace(/^﻿/, '').trim();
    if (!body) return { items: [], warnings: ['Порожньо: у буфері або файлі немає тексту.'], matched: [] };

    /* Підказку Excel прибираємо, але розділювач беремо з неї: вона точніша
       за будь-яке вгадування. */
    let delim = null;
    const sepLine = body.match(/^sep=(.)\s*$/im);
    if (sepLine) { delim = sepLine[1]; body = body.replace(/^sep=.\s*$/im, '').trim(); }
    if (!delim) delim = detectDelimiter(body);

    const rows = parseDelimited(body, delim).filter((r) => !isSkippable(r));
    if (!rows.length) return { items: [], warnings: ['У тексті немає жодного рядка з даними.'], matched: [] };

    /* Чи перший рядок — заголовки. Критерій простий: він впізнається
       як підписи полів і при цьому не є суцільними числами. */
    const first = rows[0];
    const asHeaders = first.map((h) => matchField(h, fields));
    const looksLikeHeader = asHeaders.filter(Boolean).length >= 2
      && first.filter((c) => numberFrom(c, { step: 0.1 }) !== null).length < first.length - 1;

    let columns;
    if (looksLikeHeader) {
      columns = asHeaders;
      first.forEach((h, i) => {
        if (!columns[i] && String(h ?? '').trim()) {
          warnings.push('Колонку «' + String(h).trim() + '» пропущено: такого поля в цій задачі немає.');
        }
      });
      const missing = fields.filter((f) => !columns.includes(f));
      if (missing.length) {
        warnings.push('Не знайдено колонки: ' + missing.map((f) => f.label).join(', ') +
                      ' — підставлено типові значення.');
      }
    } else {
      /* Без заголовків читаємо за порядком полів. Так працює вставка
         куска таблиці без «шапки». */
      columns = fields.slice(0, first.length);
      warnings.push('Заголовків не знайдено — колонки прочитано за порядком: ' +
                    columns.map((f) => f.label).join(', ') + '.');
    }

    const dataRows = looksLikeHeader ? rows.slice(1) : rows;
    const items = [];

    dataRows.forEach((cells, n) => {
      const item = {};
      fields.forEach((f) => { item[f.key] = f.def; });
      /* Рядок вважаємо справжнім, лише якщо в ньому є назва або хоч одне
         число. Самого типу зі списку не досить: у шаблоні, заповненому в
         Excel, залишаються рядки, де людина обрала тип зі випадайки й
         нічого не вписала. Такий рядок — слід шаблону, а не об'єкт. */
      let filled = false;

      columns.forEach((f, i) => {
        if (!f) return;
        const raw = cells[i];
        if (raw === undefined || String(raw).trim() === '') return;

        if (f.type === 'text') {
          item[f.key] = String(raw).trim().slice(0, 90);
          filled = true;
        } else if (f.type === 'select') {
          const key = optionKey(raw, f.options);
          if (key) { item[f.key] = key; } else {
            warnings.push('Рядок ' + (n + 1) + ': тип «' + String(raw).trim() +
                          '» невідомий — поставлено «' + f.options[f.def].label + '».');
          }
        } else {
          const num = numberFrom(raw, f);
          if (num === null) {
            warnings.push('Рядок ' + (n + 1) + ': «' + String(raw).trim() + '» у колонці «' +
                          f.label + '» не схоже на число — узято ' + f.def + '.');
          } else {
            const safe = clampField(num, f);
            if (safe !== num) {
              warnings.push('Рядок ' + (n + 1) + ': ' + f.label.toLowerCase() + ' ' + num +
                            ' поза межами — обрізано до ' + safe + '.');
            }
            item[f.key] = safe;
            filled = true;
          }
        }
      });

      if (!filled) return;
      if (!String(item.name || '').trim()) item.name = scenario.itemName + ' ' + (items.length + 1);
      items.push(item);
    });

    if (!items.length) warnings.push('Жодного рядка з даними розпізнати не вдалося.');

    return {
      items,
      warnings,
      matched: columns.map((f, i) => ({ header: String(first[i] ?? '').trim(), field: f })),
      hadHeaders: looksLikeHeader,
      delimiter: delim,
    };
  }

  /* ─────────────────────── назовні ─────────────────────── */

  const cell = (v) => {
    const s = String(v ?? '');
    return /["\n;,\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function headerFor(f) {
    return f.unit && !/^\d+[–-]\d+$/.test(f.unit) ? f.label + ', ' + f.unit : f.label;
  }

  function rowFor(scenario, item) {
    return scenario.itemFields.map((f) => {
      const v = item[f.key];
      if (f.type === 'select') return cell(f.options[v]?.label ?? v);
      if (f.type === 'number') return cell(numberOut(Number(v)));
      return cell(v);
    }).join(SEP);
  }

  /** Таблиця громади у CSV — щоб правити в Excel. */
  function itemsToCsv(scenario, items) {
    const lines = [SEP_HINT, scenario.itemFields.map((f) => cell(headerFor(f))).join(SEP)];
    items.forEach((it) => lines.push(rowFor(scenario, it)));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  /**
   * Порожній шаблон із правильними заголовками.
   * Потрібен не менше за імпорт: у громаді таблицю заповнює людина, яка
   * цього застосунку не бачила. Їй треба надіслати файл, а не інструкцію.
   */
  function templateCsv(scenario) {
    const sample = (scenario.demo?.items || []).slice(0, 2);
    const lines = [
      SEP_HINT,
      '# ' + scenario.title + ' — шаблон таблиці',
      '# Заповніть рядки нижче. Два перші — приклад, їх можна стерти.',
      '# Умови (бюджет, населення) вводяться у застосунку, не тут.',
      scenario.itemFields.map((f) => cell(headerFor(f))).join(SEP),
    ];
    sample.forEach((it) => lines.push(rowFor(scenario, it)));
    if (!sample.length) lines.push(scenario.itemFields.map(() => '').join(SEP));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  /** Та сама таблиця табуляцією — формат буфера обміну Excel і Sheets. */
  function itemsToTsv(scenario, items) {
    const head = scenario.itemFields.map((f) => headerFor(f)).join('\t');
    const body = items.map((it) => scenario.itemFields.map((f) => {
      const v = it[f.key];
      if (f.type === 'select') return f.options[v]?.label ?? v;
      if (f.type === 'number') return numberOut(Number(v));
      return String(v ?? '');
    }).join('\t'));
    return [head, ...body].join('\n');
  }

  /* ─────────────── уся робота одним файлом ─────────────── */

  const CASE_TAG = 'ai-human-decision-lab';

  function caseToJson(payload) {
    return JSON.stringify({
      app: CASE_TAG,
      v: 1,
      savedAt: new Date().toISOString(),
      scenario: payload.scenarioId,
      ctx: payload.ctx,
      items: payload.items,
      weights: payload.weights ?? null,
      checks: payload.checks ?? {},
      note: payload.note ?? '',
    }, null, 2);
  }

  /** Розбір кейсу. Чужий або зіпсований файл має сказати, що з ним не так,
   *  а не тихо підставити порожнечу. */
  function caseFromJson(text, scenarios) {
    let data;
    try { data = JSON.parse(String(text)); } catch { throw new Error('Це не JSON: файл зіпсований або не той.'); }
    if (!data || typeof data !== 'object') throw new Error('У файлі немає збереженої роботи.');
    if (data.app && data.app !== CASE_TAG) throw new Error('Файл зроблений іншим застосунком.');

    const sc = scenarios[data.scenario];
    if (!sc) throw new Error('Невідома задача: «' + String(data.scenario) + '».');
    if (!Array.isArray(data.items) || !data.items.length) throw new Error('У файлі немає таблиці.');

    const items = data.items.map((raw, n) => {
      const item = {};
      sc.itemFields.forEach((f) => {
        const v = raw?.[f.key];
        if (f.type === 'text') {
          item[f.key] = String(v ?? '').trim().slice(0, 90) || sc.itemName + ' ' + (n + 1);
        } else if (f.type === 'select') {
          item[f.key] = Object.prototype.hasOwnProperty.call(f.options, v) ? v : (optionKey(v, f.options) || f.def);
        } else {
          const num = numberFrom(v, f);
          item[f.key] = num === null ? f.def : clampField(num, f);
        }
      });
      return item;
    });

    const ctx = {};
    sc.context.forEach((f) => {
      const num = numberFrom(data.ctx?.[f.key], f);
      ctx[f.key] = num === null ? f.def : clampField(num, f);
    });

    /* Важливості беремо лише цілими 0–5: саме такі показує повзунок,
       і саме в такому вигляді їх можна назвати вголос. */
    let weights = null;
    if (data.weights && typeof data.weights === 'object') {
      weights = {};
      sc.criteria.forEach((c) => {
        const num = numberFrom(data.weights[c.key], { step: 1 });
        weights[c.key] = num === null ? c.weight : Math.min(5, Math.max(0, Math.round(num)));
      });
    }

    const checks = {};
    if (data.checks && typeof data.checks === 'object') {
      Object.entries(data.checks).forEach(([k, v]) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 3) checks[k] = n;
      });
    }

    return { scenarioId: sc.id, ctx, items, weights, checks, note: String(data.note ?? '').slice(0, 4000) };
  }

  /* ─────────────────────── файли ─────────────────────── */

  const stamp = () => new Date().toISOString().slice(0, 10);

  function saveFile(name, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  const saveTemplate = (sc) => saveFile('shablon-' + sc.id + '.csv', templateCsv(sc), 'text/csv');
  const saveTable = (sc, items) => saveFile('dani-' + sc.id + '-' + stamp() + '.csv',
                                           itemsToCsv(sc, items), 'text/csv');
  const saveCase = (payload) => saveFile('robota-' + payload.scenarioId + '-' + stamp() + '.json',
                                         caseToJson(payload), 'application/json');

  /** Читання файла з диска. Тип визначаємо за розширенням, бо браузер
   *  для CSV інколи віддає порожній type. */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не вдалося прочитати файл.'));
      reader.onload = () => resolve({
        name: file.name,
        isJson: /\.json$/i.test(file.name) || /json/.test(file.type || ''),
        text: String(reader.result || ''),
      });
      /* windows-1251 зустрічається в старих вигрузках, але вгадувати
         кодування наосліп гірше, ніж сказати людині «збережіть як UTF-8»:
         помилкове вгадування дає сміття, яке виглядає як дані. */
      reader.readAsText(file, 'utf-8');
    });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* Без дозволу або без https clipboard недоступний — тоді старий
         спосіб через приховане поле. Він працює майже всюди. */
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  return {
    parseItems, caseFromJson, caseToJson,
    itemsToCsv, itemsToTsv, templateCsv,
    saveTemplate, saveTable, saveCase, saveFile,
    readFile, copyToClipboard,
    numberFrom,
  };
})();
