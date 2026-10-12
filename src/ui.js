/* ============================================================================
   ui.js — чотири етапи роботи.

   1. Людина подає дані   -> 2. Машина рахує і пропонує три варіанти
   3. Людина перевіряє    -> 4. Людина ухвалює рішення або відмовляється

   Назад можна повернутися будь-коли, дані не губляться. А ухвалити рішення
   без обґрунтування не можна: у цьому й полягає роль людини.
   ========================================================================== */

'use strict';

(() => {

  /* ────────────────────────── стан ────────────────────────── */

  const state = {
    stage: 1,
    maxStage: 1,
    scenarioId: null,
    ctx: {},
    items: [],
    analysis: null,
    weights: null,      // важливості, змінені людиною (null = типові)
    pickedId: null,
    checks: {},
    note: '',
    decision: null,     // 'accept' | 'adjust' | 'reject'
    reason: '',
    llmExplain: null,
    llmCritique: null,
    decidedAt: null,
    ioReport: null,     // що сказав останній імпорт
    undo: null,         // знімок даних перед імпортом — щоб було куди вернутись
    protocol: null,     // знімок зафіксованого рішення
    protocolNumber: null, // номер, виданий при фіксації
    archiveId: null,    // запис цього рішення в архіві, якщо вже є
    archiveOpen: null,  // який запис розкритий у вікні архіву
  };

  const DRAFT_KEY = 'ahdl.draft';

  const STEPS = [
    { n: 1, title: 'Дані',      sub: 'людина подає' },
    { n: 2, title: 'Аналіз',    sub: 'ШІ рахує' },
    { n: 3, title: 'Перевірка', sub: 'людина оцінює' },
    { n: 4, title: 'Рішення',   sub: 'людина ухвалює' },
  ];

  /* ────────────────────── дрібні помічники ────────────────────── */

  const $ = (sel) => document.querySelector(sel);

  /* Усе, що прийшло від людини або від мовної моделі, потрапляє в розмітку
     лише через це екранування. Інакше назва об'єкта з «<» зламала б сторінку. */
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmt = (n, d = 1) => {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    const r = Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 10 ** d) / 10 ** d;
    return r.toLocaleString('uk-UA');
  };

  function on(root, sel, event, handler) {
    root.querySelectorAll(sel).forEach((node) => node.addEventListener(event, handler));
  }

  /* Мінімальний markdown — рівно те, що просимо в промпті.
     Спершу екранування, потім розмітка: інакше модель могла б повернути
     HTML, і він виконався б у нашій сторінці. */
  function md(text) {
    const lines = esc(text).split('\n');
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    const inline = (s) => s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      const head = line.match(/^\*\*(.+?)\*\*:?$/);
      if (head) { closeList(); out.push('<h4>' + head[1] + '</h4>'); continue; }
      if (/^[-*•]\s+/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(line.replace(/^[-*•]\s+/, '')) + '</li>');
        continue;
      }
      closeList();
      out.push('<p>' + inline(line) + '</p>');
    }
    closeList();
    return out.join('');
  }

  /* ────────────────────── чернетка ────────────────────── */

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        scenarioId: state.scenarioId, ctx: state.ctx, items: state.items,
        checks: state.checks, note: state.note, weights: state.weights,
        pickedId: state.pickedId, stage: state.stage, maxStage: state.maxStage,
      }));
    } catch { /* приватний режим або переповнене сховище — не критично */ }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      return (d && d.scenarioId && SCENARIOS[d.scenarioId]) ? d : null;
    } catch { return null; }
  }

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch {} };

  /* ══════════════════════════════════════════════════════════════
     АРХІВ РІШЕНЬ

     Застосунок обіцяє, що рішення з обґрунтуванням можна перевірити
     через рік. Доки протокол живе лише на екрані, обіцянка порожня:
     перезавантаження сторінки — і документа немає. Тому зафіксовані
     рішення складаються тут.

     Лежить архів у localStorage, тобто В ЦЬОМУ браузері й більше ніде:
     дані громади не їдуть на жоден сервер. Зворотний бік чесно названий
     в інтерфейсі — інший комп'ютер архіву не побачить, тож важливі
     протоколи треба вивантажувати файлом.
     ══════════════════════════════════════════════════════════════ */

  const ARCHIVE_KEY = 'ahdl.archive';
  const SEQ_KEY = 'ahdl.protocol.seq';

  /**
   * Номер протоколу — порядковий у межах року: «7/2026». На документ, який
   * підписують і зберігають, посилаються номером, а не часом створення.
   *
   * Лічильник живе ОКРЕМО від архіву. Якби номер виводився з кількості
   * записів, очищення архіву почало б нумерацію заново — і новий протокол
   * №1 зіткнувся б із уже роздрукованим №1. Видалити номер із обігу
   * неможливо, тож лічильник лише зростає.
   */
  function nextProtocolNumber(date) {
    const year = date.getFullYear();
    let seq = {};
    try { seq = JSON.parse(localStorage.getItem(SEQ_KEY) || '{}') || {}; } catch { seq = {}; }
    const n = (Number(seq[year]) || 0) + 1;
    seq[year] = n;
    try { localStorage.setItem(SEQ_KEY, JSON.stringify(seq)); } catch { /* не критично */ }
    return n + '/' + year;
  }
  /* Межа радше від випадковості, ніж від обсягу: 60 протоколів — це
     кілограм тексту, а localStorage дають близько 5 МБ. */
  const ARCHIVE_MAX = 60;

  function loadArchive() {
    try {
      const list = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && r.protocol && r.id) : [];
    } catch { return []; }
  }

  function storeArchive(list) {
    try {
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list.slice(0, ARCHIVE_MAX)));
      return true;
    } catch {
      /* Сховище переповнене або приватний режим. Головне — не вдавати,
         що запис відбувся: людина має знати, що протокол не збережено. */
      return false;
    }
  }

  /**
   * Запис рішення в архів. Поряд зі знімком протоколу лишаються сирі дані
   * (умови, таблиця, важливості) — без них не можна буде повернутися до
   * кейсу й порахувати його заново зі зміненими числами.
   */
  function archiveSave() {
    const p = protocolSnapshot();
    const list = loadArchive();
    const record = {
      id: state.archiveId || ('d' + Date.now().toString(36)),
      protocol: p,
      source: {
        scenarioId: state.scenarioId,
        ctx: { ...state.ctx },
        items: state.items.map((i) => ({ ...i })),
        weights: state.weights,
        checks: { ...state.checks },
        note: state.note,
      },
    };

    /* Повторне натискання «Зафіксувати» після правки обґрунтування має
       виправляти той самий запис, а не плодити близнюків. */
    const at = list.findIndex((r) => r.id === record.id);
    if (at >= 0) list[at] = record; else list.unshift(record);

    state.archiveId = record.id;
    const ok = storeArchive(list);
    updateArchiveBadge();
    return ok;
  }

  function archiveRemove(id) {
    storeArchive(loadArchive().filter((r) => r.id !== id));
    if (state.archiveId === id) state.archiveId = null;
    updateArchiveBadge();
  }

  function updateArchiveBadge() {
    const btn = $('#btn-archive');
    if (!btn) return;
    const n = loadArchive().length;
    btn.querySelector('.archive-count').textContent = n ? String(n) : '';
    btn.classList.toggle('has-items', n > 0);
    btn.title = n ? n + ' ' + Engine.plural(n, 'рішення', 'рішення', 'рішень') + ' в архіві'
                  : 'Архів порожній';
  }

  /** Повернення до даних давнього рішення: кейс відкривається заново, а
   *  сам запис лишається недоторканим. */
  function archiveReopen(rec) {
    const sc = SCENARIOS[rec.source?.scenarioId];
    if (!sc) { alert('Задачі з цього рішення більше немає у застосунку.'); return; }

    state.undo = snapshot();
    state.scenarioId = sc.id;
    state.ctx = { ...rec.source.ctx };
    state.items = rec.source.items.map((i) => ({ ...i }));
    resetAnalysis();
    state.weights = rec.source.weights || null;
    state.checks = { ...(rec.source.checks || {}) };
    state.note = rec.source.note || '';
    /* Нове рішення — новий запис: інакше правка старого кейсу тихо
       перезаписала б протокол, який уже хтось читав. */
    state.archiveId = null;
    ioSay('info', 'Відкрито дані рішення від ' + whenText(rec.protocol.at) +
                  '. Архівний запис лишився без змін.');
    $('#archive-modal').hidden = true;
    goTo(1);
  }

  function renderArchive() {
    const list = loadArchive();
    const body = $('#archive-body');

    if (!list.length) {
      body.innerHTML = `<p class="modal-note">Архів порожній. Сюди потрапляє кожне
        рішення, яке ви зафіксували на четвертому етапі.</p>
        <p class="modal-note">Архів лежить у цьому браузері й нікуди не надсилається.
        Тому на іншому комп'ютері його не буде — важливі протоколи зберігайте у PDF.</p>`;
      return;
    }

    body.innerHTML = `
      <p class="modal-note">${list.length} ${Engine.plural(list.length, 'рішення', 'рішення', 'рішень')}
        у цьому браузері. Натисніть на запис, щоб побачити протокол.</p>
      <div class="arch-list">${list.map(archiveRow).join('')}</div>
      <div class="btn-row">
        <button class="btn-ghost" id="btn-arch-export" type="button">Зберегти архів (JSON)</button>
        <span class="spacer"></span>
        <button class="btn-ghost" id="btn-arch-clear" type="button">Очистити архів</button>
      </div>`;

    bindArchive(list);
  }

  function archiveRow(rec) {
    const p = rec.protocol;
    const verdict = VERDICT[p.decision] || { icon: '?', label: p.decision };
    const open = state.archiveOpen === rec.id;
    const top = p.metrics.slice(0, 2)
      .map(([label, value]) => `<span class="arch-metric"><i>${esc(label)}</i>${esc(value)}</span>`).join('');

    return `<article class="arch-item${open ? ' open' : ''}" data-rec="${esc(rec.id)}">
      <button class="arch-head" data-open="${esc(rec.id)}" type="button">
        <span class="arch-when">${p.number ? '<b>№ ' + esc(p.number) + '</b>' : ''}${esc(whenText(p.at))}</span>
        <span class="arch-main">
          <b>${esc(p.scenarioTitle)}</b>
          <span class="arch-variant">${esc(p.variantName)}</span>
          <span class="arch-metrics">${top}</span>
        </span>
        <span class="pr-verdict ${p.decision}">${verdict.icon} ${verdict.label}</span>
      </button>
      ${open ? `<div class="arch-body">${protocolHtml(p, 'archive')}</div>` : ''}
      <button class="arch-del" data-del-rec="${esc(rec.id)}" type="button"
        title="Видалити цей запис">×</button>
    </article>`;
  }

  function bindArchive(list) {
    const body = $('#archive-body');

    on(body, '[data-open]', 'click', (e) => {
      const id = e.currentTarget.dataset.open;
      state.archiveOpen = state.archiveOpen === id ? null : id;
      renderArchive();
    });

    on(body, '[data-del-rec]', 'click', (e) => {
      e.stopPropagation();
      const id = e.currentTarget.dataset.delRec;
      const rec = list.find((r) => r.id === id);
      if (!confirm('Видалити рішення від ' + whenText(rec.protocol.at) + '? Це без вороття.')) return;
      archiveRemove(id);
      if (state.archiveOpen === id) state.archiveOpen = null;
      renderArchive();
    });

    /* Протокол розкритого запису вміє те саме, що й свіжий: PDF, друк,
       повернення до даних. */
    const openRec = list.find((r) => r.id === state.archiveOpen);
    if (openRec) {
      bindProtocol(body, openRec.protocol, () => archiveReopen(openRec));
    }

    $('#btn-arch-export').addEventListener('click', () => {
      IO.saveFile('arhiv-rishen-' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify({ app: 'ai-human-decision-lab', kind: 'archive', v: 1, records: list }, null, 2),
        'application/json');
    });

    $('#btn-arch-clear').addEventListener('click', () => {
      if (!confirm('Видалити всі ' + list.length + ' рішень з архіву? Це без вороття.')) return;
      storeArchive([]);
      state.archiveOpen = null;
      state.archiveId = null;
      updateArchiveBadge();
      renderArchive();
    });
  }

  /* ────────────────────── навігація ────────────────────── */

  function renderStepper() {
    $('#stepper').innerHTML = STEPS.map((s) => {
      const cls = ['step',
        s.n === state.stage ? 'active' : '',
        s.n < state.stage ? 'done' : '',
        s.n <= state.maxStage ? 'reachable' : ''].filter(Boolean).join(' ');
      return `<button class="${cls}" data-goto="${s.n}" type="button"${s.n > state.maxStage ? ' disabled' : ''}>
        <span class="step-dot">${s.n < state.stage ? '✓' : s.n}</span>
        <span class="step-label"><b>${s.title}</b><span>${s.sub}</span></span>
      </button>`;
    }).join('');

    on($('#stepper'), '[data-goto]', 'click', (e) => {
      const n = Number(e.currentTarget.dataset.goto);
      if (n <= state.maxStage) goTo(n);
    });
  }

  function goTo(n) {
    state.stage = n;
    state.maxStage = Math.max(state.maxStage, n);
    for (let i = 1; i <= 4; i++) $('#stage-' + i).hidden = (i !== n);
    renderStepper();
    ({ 1: renderStage1, 2: renderStage2, 3: renderStage3, 4: renderStage4 }[n])();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    saveDraft();
  }

  const scenario = () => SCENARIOS[state.scenarioId];
  const picked = () => state.analysis.variants.find((v) => v.strategy.id === state.pickedId)
                    || state.analysis.variants[0];

  /* ══════════════════════════════════════════════════════════════
     ЕТАП 1 — людина подає дані
     ══════════════════════════════════════════════════════════════ */

  function renderStage1() {
    $('#scenario-picker').innerHTML = Object.values(SCENARIOS).map((s) => `
      <button class="scenario-card${state.scenarioId === s.id ? ' selected' : ''}" data-sc="${s.id}" type="button">
        <span class="scenario-icon">${s.icon}</span>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.tagline)}</p>
      </button>`).join('');

    on($('#scenario-picker'), '[data-sc]', 'click', (e) => {
      const id = e.currentTarget.dataset.sc;
      if (state.scenarioId !== id) {
        state.scenarioId = id;
        /* Дані однієї задачі не мають сенсу в іншій, тож усе далі обнуляється. */
        state.items = [];
        state.ctx = {};
        SCENARIOS[id].context.forEach((f) => { state.ctx[f.key] = f.def; });
        resetAnalysis();
      }
      renderStage1();
    });

    const box = $('#data-form');
    if (!state.scenarioId) { box.hidden = true; return; }
    box.hidden = false;

    const sc = scenario();
    box.innerHTML = `
      <div class="card fade-in">
        <div class="card-head"><div>
          <h3>${esc(sc.question)}</h3>
        </div></div>
        <div class="field-grid">${sc.context.map(ctxField).join('')}</div>
      </div>

      <div class="card fade-in" id="items-card">
        <div class="card-head">
          <div>
            <h3>${esc(sc.itemNamePlural)}</h3>
            <p>Заповніть вручну, візьміть приклад або принесіть готову таблицю з Excel.</p>
          </div>
          <button class="btn-ghost" id="btn-clear" type="button"${state.items.length ? '' : ' disabled'}>Очистити</button>
        </div>

        <div class="io-bar">
          <span class="io-group">
            <button class="btn-ghost" id="btn-demo" type="button">Приклад громади</button>
            <button class="btn-ghost" id="btn-open" type="button">Відкрити файл…</button>
            <button class="btn-ghost" id="btn-template" type="button"
              title="Порожня таблиця з правильними заголовками — щоб заповнили в Excel">Шаблон CSV</button>
          </span>
          <span class="spacer"></span>
          <span class="io-group">
            <button class="btn-ghost" id="btn-save-csv" type="button"${state.items.length ? '' : ' disabled'}
              title="Таблиця для Excel">Зберегти CSV</button>
            <button class="btn-ghost" id="btn-save-case" type="button"${state.items.length ? '' : ' disabled'}
              title="Умови, таблиця, важливості й відповіді перевірки — одним файлом">Зберегти все</button>
            <button class="btn-ghost" id="btn-copy" type="button"${state.items.length ? '' : ' disabled'}
              title="Скопіювати таблицю, щоб вставити в Excel">Копіювати</button>
          </span>
          <input type="file" id="io-file" accept=".csv,.tsv,.txt,.json" hidden>
        </div>
        <p class="btn-hint io-hint">«Зберегти CSV» — лише таблиця, щоб правити в Excel.
          «Зберегти все» — ще й умови, важливості та відповіді перевірки: такий файл
          відкриється з тим самим розрахунком у вас або в колеги.</p>

        <div id="io-report">${ioReportHtml()}</div>
        ${state.items.length ? itemsTable(sc) : `<div class="empty drop-hint">
          <b>Порожньо.</b>
          <span>Перетягніть сюди файл CSV або JSON, вставте таблицю з Excel через Ctrl+V
          або натисніть «Приклад громади».</span></div>`}
        <div class="btn-row">
          <button class="btn-ghost" id="btn-add" type="button">+ Додати ${esc(sc.itemName.toLowerCase())}</button>
          <span class="spacer"></span>
          <button class="btn" id="btn-analyze" type="button"${state.items.length < 2 ? ' disabled' : ''}>
            Аналізувати →
          </button>
        </div>
        ${state.items.length < 2
          ? '<p class="f hint" style="margin-top:10px">Потрібно хоча б два записи.</p>' : ''}
      </div>`;

    bindStage1(sc);
  }

  function ctxField(f) {
    const v = state.ctx[f.key] ?? f.def;
    return `<div class="f">
      <label for="ctx-${f.key}">${esc(f.label)}${f.unit ? `<span class="unit">, ${esc(f.unit)}</span>` : ''}</label>
      <input type="number" id="ctx-${f.key}" data-ctx="${f.key}" value="${v}"
             min="${f.min ?? 0}" max="${f.max ?? 1e9}" step="${f.step ?? 1}">
    </div>`;
  }

  function itemsTable(sc) {
    const head = sc.itemFields.map((f) => {
      const cls = f.type === 'text' ? 'col-name' : f.type === 'select' ? 'col-type' : 'col-num';
      return `<th class="${cls}">${esc(f.label)}${f.unit
        ? `<br><span style="font-weight:400;text-transform:none;letter-spacing:0">${esc(f.unit)}</span>` : ''}</th>`;
    }).join('');

    const rows = state.items.map((item, i) => {
      const cells = sc.itemFields.map((f) => {
        const val = item[f.key] ?? f.def;
        if (f.type === 'select') {
          const opts = Object.entries(f.options).map(([k, o]) =>
            `<option value="${k}"${val === k ? ' selected' : ''}>${o.icon} ${esc(o.label)}</option>`).join('');
          return `<td><select data-row="${i}" data-key="${f.key}">${opts}</select></td>`;
        }
        if (f.type === 'text') {
          return `<td><input type="text" data-row="${i}" data-key="${f.key}" value="${esc(val)}" placeholder="Назва"></td>`;
        }
        return `<td><input type="number" data-row="${i}" data-key="${f.key}" value="${val}"
                   min="${f.min ?? 0}" max="${f.max ?? 1e9}" step="${f.step ?? 1}"></td>`;
      }).join('');
      return `<tr>${cells}<td class="col-del"><button class="row-del" data-del="${i}" type="button" title="Видалити">×</button></td></tr>`;
    }).join('');

    return `<div class="table-wrap"><table class="items">
      <thead><tr>${head}<th class="col-del"></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function bindStage1(sc) {
    const box = $('#data-form');

    on(box, '[data-ctx]', 'input', (e) => {
      state.ctx[e.target.dataset.ctx] = Number(e.target.value);
      saveDraft();
    });

    on(box, '[data-row]', 'input', (e) => {
      const { row, key } = e.target.dataset;
      const field = sc.itemFields.find((f) => f.key === key);
      state.items[row][key] = field.type === 'number' ? Number(e.target.value) : e.target.value;

      /* Вибір зі списку підставляє типове число у зв'язане поле: тип
         об'єкта — критичність, галузь — зарплату. Яке саме поле, сказано
         в описі сценарію (fills), щоб знання жило в предметній моделі,
         а не в обробнику події. Виправлене руками число не торкаємо —
         воно головніше за будь-яку підказку. */
      if (field.type === 'select' && field.fills) {
        state.items[row][field.fills] = field.options[e.target.value][field.fills];
        renderStage1();
      }
      saveDraft();
    });

    on(box, '[data-del]', 'click', (e) => {
      state.items.splice(Number(e.currentTarget.dataset.del), 1);
      resetAnalysis();
      renderStage1();
    });

    $('#btn-add').addEventListener('click', () => {
      const row = {};
      sc.itemFields.forEach((f) => { row[f.key] = f.def; });
      row.name = sc.itemName + ' ' + (state.items.length + 1);
      state.items.push(row);
      resetAnalysis();
      renderStage1();
    });

    $('#btn-demo').addEventListener('click', () => {
      state.ctx = { ...sc.demo.context };
      state.items = sc.demo.items.map((i) => ({ ...i }));
      resetAnalysis();
      renderStage1();
    });

    $('#btn-clear').addEventListener('click', () => {
      if (!state.items.length) return;
      state.undo = snapshot();
      state.items = [];
      resetAnalysis();
      ioSay('info', 'Таблицю очищено.');
      renderStage1();
    });

    /* ── дані ззовні ── */

    $('#btn-template').addEventListener('click', () => IO.saveTemplate(sc));
    $('#btn-open').addEventListener('click', () => $('#io-file').click());
    $('#io-file').addEventListener('change', (e) => {
      handleFile(e.target.files?.[0]);
      e.target.value = '';   // щоб той самий файл можна було відкрити вдруге
    });

    const saveCsv = $('#btn-save-csv');
    if (!saveCsv.disabled) {
      saveCsv.addEventListener('click', () => IO.saveTable(sc, state.items));
      $('#btn-save-case').addEventListener('click', () => IO.saveCase({
        scenarioId: state.scenarioId, ctx: state.ctx, items: state.items,
        weights: state.weights, checks: state.checks, note: state.note,
      }));
      $('#btn-copy').addEventListener('click', async () => {
        const ok = await IO.copyToClipboard(IO.itemsToTsv(sc, state.items));
        ioSay(ok ? 'info' : 'warn', ok
          ? 'Таблицю скопійовано — вставте в Excel через Ctrl+V.'
          : 'Браузер не дав доступу до буфера обміну. Скористайтеся «Зберегти CSV».');
        $('#io-report').innerHTML = ioReportHtml();
        bindIoReport();
      });
    }

    bindIoReport();

    const analyze = $('#btn-analyze');
    if (analyze) analyze.addEventListener('click', runAnalysis);
  }

  /* ══════════════════════════════════════════════════════════════
     ДАНІ ЗЗОВНІ — файл, буфер обміну, кейс

     Імпорт завжди ЗАМІЩУЄ таблицю, але перед цим зберігає знімок.
     Питати «замінити чи додати?» у діалозі гірше: людина в той момент
     ще не бачила, що саме розпізналося. Дешевше показати результат і
     дати кнопку «повернути як було».
     ══════════════════════════════════════════════════════════════ */

  const snapshot = () => ({
    items: state.items.map((i) => ({ ...i })),
    ctx: { ...state.ctx },
    weights: state.weights,
    checks: { ...state.checks },
    note: state.note,
    scenarioId: state.scenarioId,
  });

  function ioSay(level, text, warnings) {
    state.ioReport = { level, text, warnings: warnings || [], undo: Boolean(state.undo) };
  }

  function ioReportHtml() {
    const r = state.ioReport;
    if (!r) return '';
    const icon = { info: 'ℹ', warn: '⚠', error: '✕' };
    const shown = r.warnings.slice(0, 8);
    const rest = r.warnings.length - shown.length;
    return `<div class="diag io-report">
      <div class="diag-item ${r.level}">
        <span class="diag-icon">${icon[r.level]}</span>
        <span>${esc(r.text)}${r.undo
          ? ' <button class="io-undo" id="btn-undo" type="button">Повернути як було</button>' : ''}</span>
      </div>
      ${shown.map((w) => `<div class="diag-item warn">
        <span class="diag-icon">⚠</span><span>${esc(w)}</span></div>`).join('')}
      ${rest > 0 ? `<div class="diag-item warn"><span class="diag-icon">⚠</span>
        <span>…і ще ${rest} ${Engine.plural(rest, 'зауваження', 'зауваження', 'зауважень')}.</span></div>` : ''}
    </div>`;
  }

  function bindIoReport() {
    const btn = $('#btn-undo');
    if (btn) btn.addEventListener('click', undoImport);
  }

  function undoImport() {
    if (!state.undo) return;
    const u = state.undo;
    state.undo = null;
    state.scenarioId = u.scenarioId;
    state.items = u.items;
    state.ctx = u.ctx;
    resetAnalysis();           // обнуляє weights, тож відновлюємо їх після
    state.weights = u.weights;
    state.checks = u.checks;
    state.note = u.note;
    state.ioReport = { level: 'info', text: 'Повернуто попередні дані.', warnings: [], undo: false };
    renderStage1();
    saveDraft();
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      const { name, isJson, text } = await IO.readFile(file);
      if (isJson) applyCase(text, name); else applyTable(text, name);
    } catch (err) {
      ioSay('error', err.message);
      renderStage1();
    }
  }

  /** Таблиця: CSV із файла або TSV із буфера обміну. */
  function applyTable(text, source) {
    const res = IO.parseItems(text, scenario());

    if (!res.items.length) {
      ioSay('error', 'Не вдалося прочитати таблицю з ' + source + '.', res.warnings);
      renderStage1();
      return;
    }

    const had = state.items.length;
    state.undo = snapshot();
    state.items = res.items;
    resetAnalysis();

    const n = res.items.length;
    ioSay(res.warnings.length ? 'warn' : 'info',
      'Прочитано ' + n + ' ' + Engine.plural(n, 'рядок', 'рядки', 'рядків') + ' з ' + source +
      (had ? ', попередні ' + had + ' замінено' : '') + '.',
      res.warnings);
    renderStage1();
    saveDraft();
  }

  /** Кейс: умови, таблиця, важливості й відповіді на питання перевірки. */
  function applyCase(text, source) {
    let data;
    try {
      data = IO.caseFromJson(text, SCENARIOS);
    } catch (err) {
      ioSay('error', err.message);
      renderStage1();
      return;
    }

    state.undo = snapshot();
    const switched = data.scenarioId !== state.scenarioId;
    state.scenarioId = data.scenarioId;
    state.ctx = data.ctx;
    state.items = data.items;
    resetAnalysis();
    state.weights = data.weights;
    state.checks = data.checks;
    state.note = data.note;

    const parts = [data.items.length + ' ' + Engine.plural(data.items.length, 'рядок', 'рядки', 'рядків')];
    if (data.weights) parts.push('змінені важливості');
    if (Object.keys(data.checks).length) parts.push('відповіді перевірки');
    if (data.note) parts.push('примітку');

    ioSay('info', 'Відкрито збережену роботу з ' + source + ': ' + parts.join(', ') +
      (switched ? '. Задачу перемкнено на «' + SCENARIOS[data.scenarioId].title + '»' : '') + '.');
    renderStage1();
    saveDraft();
  }

  /** Перетягування файла. Підсвічуємо картку з таблицею, а ловимо подію на
   *  всьому етапі: люди кидають файл приблизно, а не точно в рамку.
   *
   *  Ставиться РАЗ із init(). Елемент #data-form живе весь сеанс і при
   *  перемальовуванні етапу лише змінює вміст, тож слухачі на ньому не
   *  зникають — привязка з bindStage1 множила б їх на кожне натискання
   *  в таблиці, а разом з ними й лічильник depth. */
  function bindDrop() {
    const zone = $('#data-form');
    if (!zone) return;
    let depth = 0;

    /* Картку шукаємо в момент події: між привязкою і подією етап міг
       перемалюватися, і старе посилання вело б у нікуди. */
    const card = () => $('#items-card');
    const paint = (on) => card()?.classList.toggle('drop-on', on);
    const active = () => state.stage === 1 && state.scenarioId;

    zone.addEventListener('dragenter', (e) => {
      if (!active()) return;
      e.preventDefault(); depth++; paint(true);
    });
    zone.addEventListener('dragover', (e) => { if (active()) e.preventDefault(); });
    zone.addEventListener('dragleave', (e) => {
      if (!active()) return;
      e.preventDefault();
      if (--depth <= 0) { depth = 0; paint(false); }
    });
    zone.addEventListener('drop', (e) => {
      if (!active()) return;
      e.preventDefault();
      depth = 0; paint(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });
  }

  /* Зміна вхідних даних знецінює і аналіз, і вибір людини: показувати
     висновки для даних, яких уже немає, — гірше, ніж не показувати нічого. */
  function resetAnalysis() {
    state.analysis = null;
    state.weights = null;
    state.pickedId = null;
    state.llmExplain = null;
    state.llmCritique = null;
    state.decision = null;
    state.reason = '';
    state.decidedAt = null;
    state.protocol = null;
    state.protocolNumber = null;
    state.archiveId = null;
    state.maxStage = 1;
  }

  /* ══════════════════════════════════════════════════════════════
     ЕТАП 2 — машина рахує
     ══════════════════════════════════════════════════════════════ */

  function runAnalysis() {
    state.analysis = Engine.analyze(scenario(), state.items, state.ctx, state.weights);
    state.llmExplain = null;
    goTo(2);
  }

  function renderStage2() {
    if (!state.analysis) { goTo(1); return; }
    const sc = scenario();
    const a = state.analysis;

    $('#analysis').innerHTML = `
      ${diagnosticsHtml(a.diagnostics)}
      ${howItWorks(sc)}
      <div class="variants">${a.variants.map(variantCard).join('')}</div>
      <div id="calc-panel"></div>
      <div class="llm-block" id="llm-explain"></div>
      <div class="btn-row">
        <button class="btn-ghost" data-back="1" type="button">← Змінити дані</button>
        <span class="spacer"></span>
        <button class="btn" data-next="3" type="button">Перейти до перевірки →</button>
      </div>`;

    bindNav($('#analysis'));
    bindExplainers($('#analysis'));
    requestExplain();
  }

  function diagnosticsHtml(diags) {
    if (!diags.length) return '';
    const icon = { info: 'ℹ', warn: '⚠', error: '✕' };
    return `<div class="diag">${diags.map((d) => `
      <div class="diag-item ${d.level}">
        <span class="diag-icon">${icon[d.level]}</span><span>${esc(d.text)}</span>
      </div>`).join('')}</div>`;
  }

  /* Пояснення методу трьома кроками. Це те, що людина має змогти
     переказати своїми словами — інакше вона не зможе ані довіряти
     розрахунку, ані з ним сперечатися. */
  function howItWorks(sc) {
    const last = { priority: 'беремо згори вниз, поки вистачає грошей',
                   budget:   'ділимо гроші пропорційно до балів',
                   return:   'межу задає найслабша ланка',
                   jobs:     'беремо згори вниз, поки вистачає грошей' }[sc.id];
    /* Критерії тут навмисно не перелічуються: вони й так видно
       в розкладі балу, а двічі пояснювати одне й те саме — зайвий текст. */
    return `<ol class="how-steps">
      <li><b>Оцінка</b><span>три оцінки від 0 до 10</span></li>
      <li><b>Бал</b><span>оцінки × важливість, далі середнє</span></li>
      <li><b>${esc(sc.resultWord)}</b><span>${esc(last)}</span></li>
    </ol>`;
  }

  function variantCard(v, idx) {
    const s = v.strategy;
    const metrics = v.metrics.map((m) => `
      <div class="metric">
        <span class="metric-label">${esc(m.label)}</span>
        <span class="metric-value">${typeof m.value === 'number' ? fmt(m.value) : esc(m.value)}${
          m.unit ? ` <small>${esc(m.unit)}</small>` : ''}${
          m.of !== undefined ? ` <small>/ ${fmt(m.of)}</small>` : ''}
          ${m.note ? `<span class="metric-note">${esc(m.note)}</span>` : ''}</span>
      </div>`).join('');

    return `<article class="variant" data-accent="${s.accent}">
      <div class="variant-title"><h3>${esc(s.name)}</h3></div>
      <p class="variant-summary">${esc(s.summary)}</p>
      <div class="weights-mini">${Object.entries(s.weights)
        .map(([k, w]) => `<span class="wm"><i>${esc(shortCrit(k))}</i>${w}</span>`).join('')}</div>
      <div class="metrics">${metrics}</div>
      ${v.note ? `<p class="variant-note">${esc(v.note)}</p>` : ''}
      <div class="tradeoff"><b>Чим платимо:</b> ${esc(s.tradeoff)}</div>
      ${variantChips(v)}
      <button class="explain-btn" data-explain="${idx}" type="button">Показати розрахунок</button>
    </article>`;
  }

  const shortCrit = (key) => {
    const c = scenario().criteria.find((x) => x.key === key);
    if (!c) return key;
    return c.label.replace(/^(Скільки|Наскільки)\s+/i, '').replace(/\s+для громади$/, '');
  };

  function variantChips(v) {
    if (v.chosen) {
      return `<div class="chips">${v.chosen.length
        ? v.chosen.map((c) => `<span class="chip in">${esc(c.item.name)}</span>`).join(' ')
        : '<span class="chip">нічого не вміщується в бюджет</span>'}</div>`;
    }
    if (v.allocation) {
      return `<div class="chips">${v.allocation.slice(0, 4)
        .map((a) => `<span class="chip in">${esc(a.item.name)} <span class="num">${fmt(a.money)}</span></span>`).join(' ')}</div>`;
    }
    if (v.links) {
      return `<div class="chips">${v.links.slice(0, 3)
        .map((l) => `<span class="chip">${esc(l.item.name)} <span class="num">${fmt(l.free, 0)}</span></span>`).join(' ')}</div>`;
    }
    return '';
  }

  /* Розрахунок розкривається не всередині картки, а окремою панеллю на всю
     ширину під варіантами. У колонці шириною ~300px таблиця на дванадцять
     рядків читається як дрібний друк; тут вона має місце дихати.
     Будуємо лише на вимогу: це сотні вузлів DOM, які здебільшого не потрібні. */
  function bindExplainers(root) {
    on(root, '[data-explain]', 'click', (e) => {
      const idx = Number(e.currentTarget.dataset.explain);
      const panel = $('#calc-panel');
      const open = panel.dataset.shown === String(idx);

      root.querySelectorAll('.explain-btn').forEach((b) => b.classList.remove('on'));

      if (open) {
        panel.innerHTML = '';
        delete panel.dataset.shown;
        return;
      }

      e.currentTarget.classList.add('on');
      const v = state.analysis.variants[idx];
      panel.innerHTML = `<div class="calc-panel fade-in" data-accent="${v.strategy.accent}">
        <div class="calc-panel-head">
          <h3>Розрахунок: ${esc(v.strategy.name)}</h3>
          <button class="btn-icon" data-close-calc="1" type="button" aria-label="Закрити">&times;</button>
        </div>
        <div class="calc-panel-body">${buildExplain(v)}</div>
      </div>`;
      panel.dataset.shown = String(idx);

      on(panel, '[data-close-calc]', 'click', () => {
        panel.innerHTML = '';
        delete panel.dataset.shown;
        root.querySelectorAll('.explain-btn').forEach((b) => b.classList.remove('on'));
      });

      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  /** Розклад одного балу «в стовпчик» — так, як рахують на папері. */
  function scoreBreakdown(entry, sc) {
    const unitOf = (key) => {
      const c = sc.criteria.find((x) => x.key === key);
      const f = sc.itemFields.find((x) => x.key === c.from);
      /* Розраховані критерії — ціна місця, вільні місця — свого поля в
         таблиці не мають, тож одиницю беремо з опису критерію. */
      const unit = f?.unit || c.unit || '';
      /* Для полів-шкал одиниця («0–10») поруч зі значенням читається як сміття:
         виходить «10 0–10». Сама шкала й так видно з оцінки праворуч. */
      return /^\d+[–-]\d+$/.test(unit) ? '' : unit;
    };

    /* Не таблиця, а рядок-формула на кожен критерій: у колонці варіанта
       ширини близько 230px таблиця з шістьма стовпцями просто не вміщується,
       і останній стовпець — той самий, де стоїть результат — зрізається. */
    const rows = entry.parts.map((p) => `
      <div class="calc-row">
        <div class="calc-name">${esc(p.label)}</div>
        <div class="calc-math">
          <span class="raw">${fmt(p.raw)}${unitOf(p.key) ? ' ' + esc(unitOf(p.key)) : ''}</span>
          <span class="arrow">→</span>
          <span class="hi">${p.score}</span>
          <span class="dim">× ${p.weight} =</span>
          <span class="eq">${fmt(p.score * p.weight)}</span>
        </div>
      </div>`).join('');

    const total = entry.parts.reduce((a, p) => a + p.score * p.weight, 0);
    return `<div class="calc">
      ${rows}
      <div class="calc-sum">
        <span>Сума</span><span class="eq">${fmt(total)}</span>
      </div>
      <div class="calc-final">
        <span>${fmt(total)} ÷ ${entry.weightTotal} <small>(сума важливостей)</small></span>
        <span class="big">${entry.score}</span>
      </div>
    </div>`;
  }

  function buildExplain(v) {
    const sc = scenario();
    const top = v.ranked[0];
    const rows = v.ranked.map((s) => resultRow(s, v, sc)).join('');
    const heads = {
      priority: ['Об\'єкт', 'Вартість', 'Бал', ''],
      budget:   ['Сфера', 'Отримає', 'Бал', ''],
      return:   ['Ланка', 'Вільно', 'Бал', ''],
      jobs:     ['Напрям', 'Місць і вартість', 'Бал', ''],
    }[sc.id];

    /* Дві колонки: зліва як вийшов один бал, справа — усі разом.
       На вузькому екрані сітка сама складається в одну колонку. */
    return `<div class="calc-grid">
      <div>
        <p class="explain-lead">Бал <b>${esc(top.item.name)}</b> — решта рахується так само.</p>
        ${scoreBreakdown(top, sc)}
      </div>
      <div>
        <p class="explain-lead">Усі, за спаданням балу:</p>
        <table class="result">
          <thead><tr><th>${heads[0]}</th><th class="n">${heads[1]}</th><th class="n">${heads[2]}</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${queueBlock(v)}
      </div>
    </div>`;
  }

  /* Драбина підняття межі: що розширювати, доки й якою ціною. Без неї
     розрахунок каже, скількох прийняти, але мовчить про те, що робити.

     Ціна місця в колонці зростає зверху вниз, і це головне, що тут видно:
     поки вузьке місце одне, місце дешеве; коли вузьких стає більше,
     кожне наступне місце коштує як сума всіх них. */
  function queueBlock(v) {
    if (!v.queue || !v.queue.length) return '';
    const rows = v.queue.map((q, i) => `
      <tr>
        <td><b>${i + 1}.</b> ${esc(q.name)}</td>
        <td class="n">до ${fmt(q.to, 0)} <small>осіб</small></td>
        <td class="n">+${fmt(q.need, 0)}</td>
        <td class="n hi">${fmt(q.cost)} млн</td>
        <td class="n">${fmt(q.per, 0)} <small>тис./місце</small></td>
      </tr>`).join('');
    return `
      <p class="explain-lead" style="margin-top:22px">Що розширювати і якою ціною:</p>
      <table class="result queue">
        <thead><tr><th>Розширюємо</th><th class="n">Межа</th><th class="n">Місць</th>
          <th class="n">Ціна кроку</th><th class="n">Ціна місця</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="explain-lead" style="margin-top:8px">Ціна місця зростає, бо вузьких ланок
        стає більше: щоб прийняти ще одну людину, розширювати доводиться кожну з них одразу.</p>`;
  }

  function resultRow(s, v, sc) {
    if (sc.id === 'jobs') {
      const inPlan = v.chosen.some((c) => c.index === s.index);
      /* Поряд із місцями показуємо ціну одного: «48 місць за 6 млн» і
         «9 місць за 4 млн» на око не порівняти, а саме це порівняння
         і є суттю другого критерію. */
      const perJob = Math.round((s.item.cost * 1000) / Math.max(1, s.item.jobs));
      return `<tr class="${inPlan ? '' : 'out'}">
        <td>${esc(s.item.name)}</td>
        <td class="n">${fmt(s.item.jobs, 0)} за ${fmt(s.item.cost)} млн
          <small>${fmt(perJob, 0)} тис./місце</small></td>
        <td class="n hi">${s.score}</td>
        <td>${inPlan ? '<span class="tag in">у програмі</span>'
                     : '<span class="tag out">не вмістився</span>'}</td>
      </tr>`;
    }
    if (sc.id === 'priority') {
      const inPlan = v.chosen.some((c) => c.index === s.index);
      return `<tr class="${inPlan ? '' : 'out'}">
        <td>${esc(s.item.name)}</td>
        <td class="n">${fmt(s.item.cost)} млн</td>
        <td class="n hi">${s.score}</td>
        <td>${inPlan ? '<span class="tag in">у плані</span>' : '<span class="tag out">не вмістився</span>'}</td>
      </tr>`;
    }
    if (sc.id === 'budget') {
      const a = v.allocation.find((x) => x.index === s.index);
      return `<tr>
        <td>${esc(s.item.name)}</td>
        <td class="n">${fmt(a.money)} млн <small>(${a.share}%)</small></td>
        <td class="n hi">${s.score}</td>
        <td><span class="tag ${a.share >= 100 / v.allocation.length ? 'in' : 'out'}">${
          a.share >= 100 / v.allocation.length ? 'більше середнього' : 'менше середнього'}</span></td>
      </tr>`;
    }
    const l = v.links.find((x) => x.index === s.index);
    const weakest = l.index === v.weakest.index;
    return `<tr class="${weakest ? '' : 'out'}">
      <td>${esc(s.item.name)}</td>
      <td class="n">${fmt(l.free, 0)} місць</td>
      <td class="n hi">${s.score}</td>
      <td>${weakest ? '<span class="tag cut">найслабша ланка</span>' : ''}</td>
    </tr>`;
  }

  /* ─────────────── пояснення мовною моделлю ─────────────── */

  function llmPlaceholder(title) {
    return `<div class="llm-head"><h3>🧠 ${title}</h3></div>
      <div class="llm-loading"><span class="spin"></span> Готуємо…</div>`;
  }

  function renderLlm(box, title, result, extraBtn = '') {
    const src = result.source === 'groq'
      ? `<span class="llm-src groq">${esc(result.model || 'groq')}</span>`
      : '<span class="llm-src local">локально, без мережі</span>';

    box.innerHTML = `
      <div class="llm-head">
        <h3>🧠 ${title}</h3>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${src}
          <button class="btn-ghost" data-show-digest="1" type="button">Що надсилалось</button>
          ${extraBtn}
        </div>
      </div>
      ${result.error ? `<div class="llm-error">Groq не відповів: ${esc(result.error)} — текст нижче складено локально.</div>` : ''}
      <div class="prose">${md(result.text)}</div>`;

    on(box, '[data-show-digest]', 'click', showDigest);
  }

  async function requestExplain() {
    const box = $('#llm-explain');
    if (!box) return;
    if (!state.llmExplain) {
      box.innerHTML = llmPlaceholder('Пояснення');
      state.llmExplain = await LLM.explain(scenario(), state.ctx, state.analysis);
    }
    renderLlm(box, 'Пояснення', state.llmExplain, refreshBtn());
    on(box, '[data-refresh]', 'click', async () => {
      box.innerHTML = llmPlaceholder('Пояснення');
      state.llmExplain = await LLM.explain(scenario(), state.ctx, state.analysis);
      renderLlm(box, 'Пояснення', state.llmExplain, refreshBtn());
      bindExplainRefresh(box);
    });
  }

  function bindExplainRefresh(box) {
    on(box, '[data-refresh]', 'click', requestExplain);
    on(box, '[data-show-digest]', 'click', showDigest);
  }

  const refreshBtn = () => (LLM.isOn()
    ? '<button class="btn-ghost" data-refresh="1" type="button">Перезапитати</button>' : '');

  function showDigest() {
    $('#digest-text').textContent = LLM.digest(scenario(), state.ctx, state.analysis);
    $('#digest-modal').hidden = false;
  }

  /* ══════════════════════════════════════════════════════════════
     ЕТАП 3 — людина перевіряє
     ══════════════════════════════════════════════════════════════ */

  function renderStage3() {
    if (!state.analysis) { goTo(1); return; }
    const sc = scenario();
    if (!state.pickedId) state.pickedId = state.analysis.variants[0].strategy.id;

    $('#review').innerHTML = `
      <div class="card">
        <div class="card-head"><div>
          <h3>1. Який варіант вам ближчий?</h3>
        </div></div>
        <div class="variants compact" id="pick-list">${state.analysis.variants.map(pickCard).join('')}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>2. Чи згодні ви з важливістю критеріїв?</h3>
            <p>Пересуньте повзунок — усі три варіанти перерахуються, а нижче буде видно, що саме змінилось.</p>
          </div>
          <button class="btn-ghost" id="btn-reset-w" type="button">Повернути типові</button>
        </div>
        ${sc.criteria.map(weightRow).join('')}
        <div class="recalc" id="recalc-note"></div>
      </div>

      <div class="card">
        <div class="card-head"><div>
          <h3>3. Що знаєте ви, а модель — ні</h3>
          <p>Модель бачить лише числа з таблиці. Ці чотири питання — про решту. Відповіді потраплять у протокол.</p>
        </div></div>
        ${HUMAN_CHECKS.map(checkRow).join('')}
      </div>

      <div class="card">
        <div class="card-head"><div>
          <h3>4. Що ви знаєте про громаду?</h3>
        </div></div>
        <div class="f">
          <textarea id="note" placeholder="Наприклад: земля під мостом у суді; донор дає гроші лише на школи.">${esc(state.note)}</textarea>
        </div>
      </div>

      <div class="llm-block" id="llm-critique">
        <div class="llm-head"><h3>🧠 Заперечення до вашого вибору</h3></div>
        <p class="modal-note">Модель навмисно шукає слабкі місця обраного варіанта, а не хвалить його.</p>
        <button class="btn-ghost" id="btn-critique" type="button">Отримати заперечення</button>
      </div>

      <div class="btn-row">
        <button class="btn-ghost" data-back="2" type="button">← До аналізу</button>
        <span class="spacer"></span>
        <button class="btn" data-next="4" type="button">До рішення →</button>
      </div>`;

    bindStage3();
    bindNav($('#review'));
  }

  /* changed — картку підсвітити: від зсуву повзунка її склад став іншим. */
  function pickCard(v, changed) {
    const s = v.strategy;
    const on = state.pickedId === s.id;
    const top = v.metrics.slice(0, 2).map((m) => `
      <div class="metric"><span class="metric-label">${esc(m.label)}</span>
      <span class="metric-value">${typeof m.value === 'number' ? fmt(m.value) : esc(m.value)}${
        m.unit ? ` <small>${esc(m.unit)}</small>` : ''}</span></div>`).join('');

    return `<article class="variant${on ? ' picked' : ''}${changed ? ' flash' : ''}"
             data-accent="${s.accent}" data-pick="${s.id}" style="cursor:pointer">
      <div class="variant-title"><h3>${esc(s.name)}</h3>${on ? '<span class="tag in">обрано</span>' : ''}</div>
      <p class="variant-summary">${esc(s.summary)}</p>
      <div class="metrics">${top}</div>
      ${variantChips(v)}
      <div class="tradeoff"><b>Чим платимо:</b> ${esc(s.tradeoff)}</div>
    </article>`;
  }

  /* Відбиток варіанта: за ним видно, чи змінився він після перерахунку. */
  function variantFingerprint(v) {
    const body = v.chosen ? v.chosen.map((c) => c.index)
      : v.allocation ? v.allocation.map((a) => a.item.name + ':' + a.share)
      : v.links.map((l) => l.item.name + ':' + l.free);
    return v.metrics.map((m) => m.value).join('|') + '#' + body.join(',');
  }

  function weightRow(c) {
    const w = state.weights ? state.weights[c.key] : c.weight;
    return `<div class="weight-row">
      <div class="weight-name">${esc(c.label)}<small>${esc(c.explain)}</small></div>
      <input type="range" data-w="${c.key}" min="0" max="5" step="1" value="${w}">
      <div class="weight-val" id="wv-${c.key}">${w}</div>
    </div>`;
  }

  function checkRow(q) {
    const cur = state.checks[q.key] ?? 0;
    const opts = q.options.map((o) =>
      `<button class="check-opt${cur === o.v ? ' on' : ''}" data-tone="${o.tone}"
        data-check="${q.key}" data-val="${o.v}" type="button">${esc(o.label)}</button>`).join('');
    return `<div class="check-row">
      <div class="check-q"><b>${esc(q.label)}</b><span>${esc(q.hint)}</span></div>
      <div class="check-opts">${opts}</div>
    </div>`;
  }

  function bindStage3() {
    const box = $('#review');

    /* Делегування: список варіантів перемальовується щоразу, коли людина
       рухає повзунок, тож вішати слухачів на кожну картку — марна робота. */
    box.addEventListener('click', (e) => {
      const card = e.target.closest('[data-pick]');
      if (!card) return;
      state.pickedId = card.dataset.pick;
      state.llmCritique = null;
      $('#pick-list').innerHTML = state.analysis.variants.map(pickCard).join('');
      saveDraft();
    });

    on(box, '[data-w]', 'input', (e) => {
      const sc = scenario();
      if (!state.weights) {
        state.weights = {};
        sc.criteria.forEach((c) => { state.weights[c.key] = c.weight; });
      }
      state.weights[e.target.dataset.w] = Number(e.target.value);
      document.getElementById('wv-' + e.target.dataset.w).textContent = e.target.value;

      /* Порівнюємо варіанти до і після перерахунку. Без цього людині
         здається, що повзунок ні на що не впливає: часто модель справді
         стійка, і план лишається тим самим. Про це треба сказати прямо,
         а не лишати екран без реакції. */
      const before = state.analysis.variants.map(variantFingerprint);
      state.analysis = Engine.analyze(sc, state.items, state.ctx, state.weights);
      const after = state.analysis.variants.map(variantFingerprint);

      const changed = after.map((f, i) => f !== before[i]);
      const n = changed.filter(Boolean).length;

      state.llmExplain = null;
      state.llmCritique = null;
      $('#pick-list').innerHTML = state.analysis.variants
        .map((v, i) => pickCard(v, changed[i])).join('');

      const note = $('#recalc-note');
      if (n) {
        const names = state.analysis.variants.filter((_, i) => changed[i])
          .map((v) => v.strategy.name).join(', ');
        note.className = 'recalc on';
        note.textContent = 'Перераховано. Змінився результат: ' + names + '.';
      } else {
        note.className = 'recalc';
        note.textContent = 'Перераховано. Результат той самий — на цю зміну модель не реагує.';
      }
      saveDraft();
    });

    $('#btn-reset-w').addEventListener('click', () => {
      state.weights = null;
      state.analysis = Engine.analyze(scenario(), state.items, state.ctx, null);
      state.llmExplain = null;
      state.llmCritique = null;
      renderStage3();
    });

    on(box, '[data-check]', 'click', (e) => {
      const { check, val } = e.currentTarget.dataset;
      state.checks[check] = Number(val);
      state.llmCritique = null;
      e.currentTarget.parentElement.querySelectorAll('[data-check]').forEach((b) => {
        b.classList.toggle('on', b.dataset.val === val);
      });
      saveDraft();
    });

    $('#note').addEventListener('input', (e) => { state.note = e.target.value; saveDraft(); });
    $('#btn-critique').addEventListener('click', requestCritique);
    if (state.llmCritique) renderLlm($('#llm-critique'), 'Заперечення до вашого вибору', state.llmCritique);
  }

  async function requestCritique() {
    const box = $('#llm-critique');
    box.innerHTML = llmPlaceholder('Заперечення до вашого вибору');
    state.llmCritique = await LLM.critique(
      scenario(), state.ctx, state.analysis, picked(), state.checks, state.note);
    renderLlm(box, 'Заперечення до вашого вибору', state.llmCritique,
      '<button class="btn-ghost" data-again="1" type="button">Ще раз</button>');
    on(box, '[data-again]', 'click', requestCritique);
  }

  /* ══════════════════════════════════════════════════════════════
     ЕТАП 4 — рішення людини
     ══════════════════════════════════════════════════════════════ */

  function renderStage4() {
    if (!state.analysis) { goTo(1); return; }
    const skipped = HUMAN_CHECKS.filter((q) => !state.checks[q.key]).length;
    const doubts = HUMAN_CHECKS.filter((q) => state.checks[q.key] === 1);

    $('#decision').innerHTML = `
      ${skipped ? `<div class="diag"><div class="diag-item warn"><span class="diag-icon">⚠</span>
        <span>Питань без відповіді: <b>${skipped}</b> із ${HUMAN_CHECKS.length}. У протоколі це буде видно.</span></div></div>` : ''}
      ${doubts.length ? `<div class="diag"><div class="diag-item error"><span class="diag-icon">✕</span>
        <span>Ви позначили сумніви: ${doubts.map((d) => esc(d.label)).join('; ')}.
        Чесніше відкласти, ніж підписати.</span></div></div>` : ''}

      <div class="card">
        <div class="card-head"><div>
          <h3>Ваше рішення щодо варіанта «${esc(picked().strategy.name)}»</h3>
        </div></div>
        <div class="choice-grid">
          <button class="choice${state.decision === 'accept' ? ' on' : ''}" data-dec="accept" type="button">
            <b>Прийняти</b><span>Погоджуюсь і відповідаю за наслідки.</span></button>
          <button class="choice${state.decision === 'adjust' ? ' on' : ''}" data-dec="adjust" type="button">
            <b>Прийняти зі змінами</b><span>Основа підходить, частину змінюю.</span></button>
          <button class="choice${state.decision === 'reject' ? ' on' : ''}" data-dec="reject" type="button">
            <b>Відмовитись</b><span>Даних бракує або ціна завелика.</span></button>
        </div>

        <div class="f" style="margin-top:18px" id="reason-box"${state.decision ? '' : ' hidden'}>
          <label for="reason">Поясніть свій вибір<span class="unit"> — без цього рішення не зафіксувати</span></label>
          <textarea id="reason" placeholder="Цей текст потрапить у протокол.">${esc(state.reason)}</textarea>
          <p class="hint">Кілька речень: що вас переконало і що турбує. Цей текст побачить той, хто читатиме протокол.</p>
        </div>

        <div class="btn-row">
          <button class="btn-ghost" data-back="3" type="button">← До перевірки</button>
          <span class="spacer"></span>
          <button class="btn" id="btn-commit" type="button"${
            state.decision && state.reason.trim().length > 9 ? '' : ' disabled'}>Зафіксувати рішення</button>
        </div>
      </div>

      <div id="protocol-box">${state.protocol ? protocolHtml(state.protocol) : ''}</div>`;

    bindStage4();
    bindNav($('#decision'));
  }

  function bindStage4() {
    const box = $('#decision');

    on(box, '[data-dec]', 'click', (e) => {
      state.decision = e.currentTarget.dataset.dec;
      state.decidedAt = null;
      state.protocol = null;
      renderStage4();
      $('#reason').focus();
    });

    const reason = $('#reason');
    if (reason) {
      reason.addEventListener('input', (e) => {
        state.reason = e.target.value;
        $('#btn-commit').disabled = !(state.decision && state.reason.trim().length > 9);
        saveDraft();
      });
    }

    $('#btn-commit').addEventListener('click', () => {
      state.decidedAt = new Date();
      /* Номер видається один раз: повторне натискання «Зафіксувати» після
         правки обґрунтування виправляє той самий протокол, а не створює
         новий документ. */
      if (!state.protocolNumber) state.protocolNumber = nextProtocolNumber(state.decidedAt);
      state.protocol = protocolSnapshot();
      const saved = archiveSave();

      const box2 = $('#protocol-box');
      box2.innerHTML = (saved ? '' : `<div class="diag"><div class="diag-item warn">
        <span class="diag-icon">⚠</span><span>Рішення не вдалося записати в архів: сховище
        браузера недоступне або переповнене. Збережіть протокол у PDF просто зараз.</span>
        </div></div>`) + protocolHtml(state.protocol);
      bindProtocol(box2, state.protocol);
      box2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    if (state.protocol) bindProtocol($('#protocol-box'), state.protocol);
  }

  const VERDICT = {
    accept: { label: 'Рішення прийнято', icon: '✓' },
    adjust: { label: 'Прийнято зі змінами', icon: '✎' },
    reject: { label: 'Від рішення відмовлено', icon: '✕' },
  };

  function planLines(v) {
    /* Для програми робочих місць головне число — місця, а не гроші:
       протокол має відповідати на те питання, яке ставила громада. */
    if (v.chosen && state.scenarioId === 'jobs') {
      return v.chosen.map((c) => [c.item.name,
        fmt(c.item.jobs, 0) + ' місць · ' + fmt(c.item.cost) + ' млн · ' + fmt(c.item.wage) + ' тис.']);
    }
    if (v.chosen) return v.chosen.map((c) => [c.item.name, fmt(c.item.cost) + ' млн']);
    if (v.allocation) return v.allocation.map((a) => [a.item.name, fmt(a.money) + ' млн (' + a.share + '%)']);
    return [[v.weakest.item.name + ' — найслабша ланка', fmt(v.weakest.free, 0) + ' місць']];
  }

  /* Протокол — це документ, а не вид на поточний стан, тому з рішення
     робиться ЗНІМОК: готові пари «підпис — значення», уже відформатовані.
     Причина не в зручності. Архів має читатися через рік, а формули за рік
     цілком можуть змінитися. Якби запис зберігав лише сирі дані й
     перераховувався на льоту, старий протокол тихо показав би інші числа,
     ніж ті, під якими стоїть підпис людини. Знімок цього не дозволяє. */
  function protocolSnapshot() {
    const sc = scenario();
    const v = picked();
    return {
      scenarioId: sc.id,
      scenarioTitle: sc.title,
      number: state.protocolNumber,
      method: sc.method,
      resultWord: sc.resultWord,
      at: (state.decidedAt || new Date()).toISOString(),
      decision: state.decision,
      variantId: v.strategy.id,
      variantName: v.strategy.name,
      variantSummary: v.strategy.summary,
      conditions: sc.context.map((f) => [f.label, state.ctx[f.key] + (f.unit ? ' ' + f.unit : '')]),
      metrics: v.metrics.map((m) => [
        m.label,
        (typeof m.value === 'number' ? fmt(m.value) : m.value) + (m.unit ? ' ' + m.unit : ''),
        m.note || '',
      ]),
      plan: planLines(v),
      checks: HUMAN_CHECKS.map((q) => [q.label, checkAnswerLabel(q, state.checks[q.key])]),
      note: state.note.trim(),
      reason: state.reason.trim(),
      weightsChanged: Boolean(state.weights),
      llmModel: state.llmExplain?.source === 'groq' ? state.llmExplain.model : null,
    };
  }

  const whenText = (iso) => new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const howCalculated = (p) => p.method + '. Розраховано у браузері' +
    (p.weightsChanged ? ', важливості змінені людиною' : ', важливості типові') + '. ' +
    (p.llmModel ? 'Пояснення — модель ' + p.llmModel + '.' : 'Пояснення складено локально.');

  /** @param where 'live' — щойно ухвалене рішення, 'archive' — запис з архіву. */
  function protocolHtml(p, where = 'live') {
    const verdict = VERDICT[p.decision];
    const li = (a, b) => `<li><span>${esc(a)}</span><span class="v">${esc(b)}</span></li>`;

    return `<div class="protocol fade-in">
      <div class="protocol-head">
        <div><h3>Протокол рішення${p.number ? ' № ' + esc(p.number) : ''}</h3>
          <div class="protocol-date">${esc(p.scenarioTitle)} · ${esc(whenText(p.at))}</div></div>
        <div class="pr-verdict ${p.decision}">${verdict.icon} ${verdict.label}</div>
      </div>

      <div class="pr-section"><h4>Обраний варіант</h4>
        <p><b>${esc(p.variantName)}</b> — ${esc(p.variantSummary)}</p></div>

      <div class="pr-section"><h4>Умови</h4>
        <ul class="pr-list">${p.conditions.map(([a, b]) => li(a, b)).join('')}</ul></div>

      <div class="pr-section"><h4>Підсумок</h4>
        <ul class="pr-list">${p.metrics.map(([a, b]) => li(a, b)).join('')}</ul></div>

      <div class="pr-section"><h4>${esc(p.resultWord)}</h4>
        <ul class="pr-list">${p.plan.map(([a, b]) => li(a, b)).join('')}</ul></div>

      <div class="pr-section"><h4>Перевірка людиною</h4>
        <ul class="pr-list">${p.checks.map(([a, b]) => li(a, b)).join('')}</ul></div>

      ${p.note ? `<div class="pr-section"><h4>Що людина знає про громаду</h4>
        <p>${esc(p.note)}</p></div>` : ''}

      <div class="pr-section"><h4>Обґрунтування</h4><p>${esc(p.reason)}</p></div>

      <div class="pr-section"><h4>Як рахувалося</h4>
        <p style="color:var(--muted);font-size:12.5px">${esc(howCalculated(p))}</p></div>

      <div class="btn-row">
        <button class="btn" data-pr-pdf="1" type="button">Зберегти PDF</button>
        <button class="btn-ghost" data-pr-print="1" type="button">Роздрукувати</button>
        <span class="spacer"></span>
        ${where === 'live'
          ? '<button class="btn-ghost" data-pr-restart="1" type="button">Почати спочатку</button>'
          : '<button class="btn-ghost" data-pr-reopen="1" type="button">Відкрити ці дані</button>'}
      </div>
      <p class="btn-hint">${where === 'live'
        ? '«Зберегти PDF» одразу завантажує файл. «Роздрукувати» відкриває системний діалог друку.'
        : 'Рішення вже зафіксоване. «Відкрити ці дані» заповнить таблицю, щоб порахувати заново — запис в архіві лишиться без змін.'}</p>
    </div>`;
  }

  /* Кнопки протоколу шукаються за data-атрибутом, а не за id: той самий
     протокол показується і на четвертому етапі, і в архіві, а два вузли
     з одним id зробили б одну з кнопок мертвою. */
  function bindProtocol(root, p, onReopen) {
    const click = (sel, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    click('[data-pr-pdf]', () => exportPdf(p));
    click('[data-pr-print]', () => printProtocol(p));
    click('[data-pr-restart]', () => {
      if (!confirm('Очистити все й почати спочатку? Архів рішень лишиться.')) return;
      clearDraft();
      location.reload();
    });
    if (onReopen) click('[data-pr-reopen]', onReopen);
  }

  /* ─────────────────────── протокол у PDF ───────────────────────

     Друкуємо окремий документ у прихованому кадрі, а не саму сторінку.
     Причини дві. По-перше, на папері потрібен інший документ: світлий,
     без навігації, з полями під формат А4 — а не темний інтерфейс.
     По-друге, це не потребує жодної бібліотеки: у PDF потрапляє
     справжній текст, який можна виділити й знайти пошуком, а не картинка.

     Далі людина в діалозі друку обирає «Зберегти як PDF» — так працює
     і Chrome, і Edge, і Firefox. */

  /** Збирає PDF у пам'яті й віддає його файлом — без діалогу друку. */
  function exportPdf(p) {
    const bytes = PDF.build(layoutProtocol(p));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    /* Час у назві, а не лише дата: двох рішень за один день цілком
       достатньо, щоб другий файл перезаписав перший. */
    a.download = 'protokol-' + (p.number ? p.number.replace('/', '-') + '-' : '')
               + p.scenarioId + '-' + p.at.slice(0, 10) + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  /** Друк — окремою дією: відкриває системний діалог із тим самим протоколом. */
  function printProtocol(p) {
    const html = buildPrintableProtocol(p);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    /* Кадр мусить мати справжні розміри: нульовий або visibility:hidden
       браузер не друкує — діалог або не відкривається, або віддає порожню
       сторінку. Тому ховаємо його за межами екрана. */
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;';
    document.body.appendChild(frame);

    frame.addEventListener('load', () => {
      requestAnimationFrame(() => setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch {
          frame.remove();
        }
        setTimeout(() => frame.remove(), 60_000);
      }, 120));
    }, { once: true });

    frame.srcdoc = html;
  }

  /* ── розкладка протоколу на сторінці PDF ──────────────────────────
     У PDF немає автоматичної верстки: кожен рядок ставиться за
     координатами, тому розкладку доводиться вести самому. */

  function layoutProtocol(p) {
    const doc = PDF.createDoc();
    const M = PDF.MARGIN;
    const G = PDF.GRAY;

    /* Заголовок і вердикт в один рядок */
    doc.text('Протокол рішення' + (p.number ? '  № ' + p.number : ''), M.left, 19);
    const verdict = VERDICT[p.decision].label;
    const vw = PDF.widthOf(verdict, 11);
    doc.text(verdict, PDF.A4.w - M.right - vw, 11,
      p.decision === 'accept' ? [0.11, 0.48, 0.29]
      : p.decision === 'adjust' ? [0.59, 0.40, 0.04] : [0.70, 0.20, 0.18]);
    doc.down(15);

    doc.text(p.scenarioTitle + ' · ' + whenText(p.at), M.left, 9, G.faint);
    doc.down(10);
    doc.rule(PDF.CONTENT_W, 1.2, [0.08, 0.09, 0.11]);
    doc.down(22);

    const heading = (title) => {
      doc.need(34);
      doc.text(title.toUpperCase(), M.left, 8, G.faint);
      doc.down(14);
    };

    heading('Обраний варіант');
    doc.paragraph(p.variantName, 12);
    doc.down(2);
    doc.paragraph(p.variantSummary, 10, G.muted);
    doc.down(16);

    heading('Умови');
    p.conditions.forEach(([label, value]) => doc.row(label, value));
    doc.down(10);

    heading('Підсумок');
    p.metrics.forEach(([label, value, note]) => doc.row(label + (note ? ' — ' + note : ''), value));
    doc.down(10);

    heading(p.resultWord);
    p.plan.forEach(([name, value]) => doc.row(name, value));
    doc.down(10);

    heading('Перевірка людиною');
    p.checks.forEach(([label, answer]) => doc.row(label, answer));
    doc.down(10);

    if (p.note) {
      heading('Що людина знає про громаду');
      doc.paragraph(p.note, 10, G.muted);
      doc.down(16);
    }

    heading('Обґрунтування');
    doc.paragraph(p.reason, 10);
    doc.down(20);

    doc.rule();
    doc.down(13);
    doc.paragraph(howCalculated(p), 8, G.faint);
    doc.down(2);
    doc.paragraph('Рішення ухвалила людина. Модель надала розрахунок і заперечення.', 8, G.faint);

    return doc.finish();
  }

  function buildPrintableProtocol(p) {
    const verdict = VERDICT[p.decision];
    const when = whenText(p.at);

    const rows = (pairs) => pairs.map(([a, b]) =>
      `<tr><td>${esc(a)}</td><td class="v">${esc(b)}</td></tr>`).join('');

    const section = (title, body) => body
      ? `<section><h2>${esc(title)}</h2>${body}</section>` : '';

    return `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8">
<title>Протокол рішення — ${esc(p.scenarioTitle)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }

  /* Системні шрифти навмисно: у кадрі для друку зовнішній шрифт може не
     встигнути завантажитись, і документ піде на друк порожнім. */
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #14171C;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  header { border-bottom: 2px solid #14171C; padding-bottom: 9px; margin-bottom: 14px; }
  .title-row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  h1 { font-size: 17pt; margin: 0; letter-spacing: -.01em; }
  h1 .num { font-size: 12.5pt; font-weight: 600; color: #5A616B; white-space: nowrap; }
  .verdict { font-size: 11pt; font-weight: 600; white-space: nowrap; }
  .verdict.accept { color: #1B7A4B; }
  .verdict.adjust { color: #96650A; }
  .verdict.reject { color: #B3322D; }
  .meta { margin-top: 6px; font-size: 9pt; color: #5A616B; }

  section { margin-bottom: 13px; page-break-inside: avoid; }
  h2 {
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: .09em;
    color: #5A616B;
    margin: 0 0 6px;
    font-weight: 600;
  }
  p { margin: 0; }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; border-bottom: 1px solid #E3E6EA; vertical-align: top; }
  td.v { text-align: right; white-space: nowrap; padding-left: 14px; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }

  .lead { font-size: 11.5pt; font-weight: 600; margin-bottom: 3px; }
  .quote {
    border-left: 2px solid #C9CED6;
    padding-left: 12px;
    color: #2B3038;
  }

  footer {
    /* Щоб підвал не лишався сам на порожній сторінці, коли протоколу
       трохи не вистачило місця. */
    break-before: avoid;
    page-break-before: avoid;
    margin-top: 16px;
    padding-top: 9px;
    border-top: 1px solid #E3E6EA;
    font-size: 8.5pt;
    color: #767C86;
  }
</style></head>
<body>
  <header>
    <div class="title-row">
      <h1>Протокол рішення${p.number ? ' <span class="num">№ ' + esc(p.number) + '</span>' : ''}</h1>
      <span class="verdict ${p.decision}">${esc(verdict.label)}</span>
    </div>
    <div class="meta">${esc(p.scenarioTitle)} · ${esc(when)}</div>
  </header>

  ${section('Обраний варіант',
    `<p class="lead">${esc(p.variantName)}</p><p>${esc(p.variantSummary)}</p>`)}

  ${section('Умови', `<table>${rows(p.conditions)}</table>`)}

  ${section('Підсумок', `<table>${rows(p.metrics.map(([a, b]) => [a, b]))}</table>`)}

  ${section(p.resultWord, `<table>${rows(p.plan)}</table>`)}

  ${section('Перевірка людиною', `<table>${rows(p.checks)}</table>`)}

  ${p.note ? section('Що людина знає про громаду', `<p class="quote">${esc(p.note)}</p>`) : ''}

  ${section('Обґрунтування', `<p class="quote">${esc(p.reason)}</p>`)}

  <footer>
    ${esc(howCalculated(p))}
    <br>Рішення ухвалила людина. Модель надала розрахунок і заперечення.
  </footer>
</body></html>`;
  }

  /* ══════════════════════════════════════════════════════════════
     НАЛАШТУВАННЯ
     ══════════════════════════════════════════════════════════════ */

  function renderSettings() {
    const models = window.__models || [];
    $('#settings-body').innerHTML = `
      <div class="set-group">
        <h4>Ключ Groq</h4>
        <div class="f">
          <input type="password" id="set-key" placeholder="gsk_…" value="${esc(LLM.store.key)}">
          <p class="hint">Ключ зберігається лише у цьому браузері й у репозиторій не потрапляє.<br>Безкоштовний ключ: console.groq.com/keys</p>
        </div>
        <button class="btn-ghost" id="set-load" type="button" style="margin-top:8px">Перевірити ключ</button>
        <div class="set-status" id="set-status"></div>
      </div>

      <div class="set-group">
        <h4>Модель</h4>
        <div class="f"><select id="set-model">
          ${models.length
            ? models.map((m) => `<option value="${esc(m.id)}"${LLM.store.model === m.id ? ' selected' : ''}>${esc(m.id)}</option>`).join('')
            : `<option value="">${LLM.hasKey() ? 'Натисніть «Перевірити ключ»' : 'Спершу введіть ключ'}</option>`}
        </select>
        <p class="hint">Список моделей завантажується з Groq, тож не застаріє.</p></div>
      </div>

      <div class="set-group">
        <h4>Мовна модель</h4>
        <label class="switch">
          <input type="checkbox" id="set-enabled"${LLM.store.enabled ? ' checked' : ''}>
          <span class="switch-track"></span>
          <span>Використовувати Groq для пояснень</span>
        </label>
        <div class="privacy-note">
          Розрахунки завжди у вашому браузері. У Groq іде лише короткий переказ
          результатів — його видно кнопкою «Що надсилалось».
        </div>
      </div>`;

    $('#set-key').addEventListener('change', (e) => { LLM.store.key = e.target.value.trim(); updateBadge(); });
    $('#set-model').addEventListener('change', (e) => { LLM.store.model = e.target.value; updateBadge(); });
    $('#set-enabled').addEventListener('change', (e) => { LLM.store.enabled = e.target.checked; updateBadge(); });

    $('#set-load').addEventListener('click', async () => {
      const st = $('#set-status');
      LLM.store.key = $('#set-key').value.trim();
      st.className = 'set-status work';
      st.textContent = 'Перевіряємо…';
      try {
        const list = await LLM.listModels();
        window.__models = list;
        if (!LLM.store.model || !list.some((m) => m.id === LLM.store.model)) {
          LLM.store.model = (list.find((m) => LLM.PREFERRED.includes(m.id)) || list[0])?.id || '';
        }
        renderSettings();
        const st2 = $('#set-status');
        st2.className = 'set-status ok';
        st2.textContent = 'Ключ робочий. Моделей доступно: ' + list.length + '.';
        updateBadge();
      } catch (err) {
        st.className = 'set-status err';
        st.textContent = err.message;
      }
    });
  }

  function updateBadge() {
    const b = $('#llm-badge');
    if (LLM.isOn()) {
      b.className = 'llm-badge on';
      b.textContent = 'Groq: ' + (LLM.store.model || 'типова модель');
    } else {
      b.className = 'llm-badge off';
      b.textContent = LLM.hasKey() ? 'LLM вимкнено' : 'Локальний режим';
    }
  }

  /* ────────────────────── спільне ────────────────────── */

  function bindNav(root) {
    on(root, '[data-back]', 'click', (e) => goTo(Number(e.currentTarget.dataset.back)));
    on(root, '[data-next]', 'click', (e) => {
      const n = Number(e.currentTarget.dataset.next);
      if (n === 4 && !state.pickedId) state.pickedId = state.analysis.variants[0].strategy.id;
      goTo(n);
    });
  }

  function init() {
    const d = loadDraft();
    if (d) {
      Object.assign(state, {
        scenarioId: d.scenarioId, ctx: d.ctx || {}, items: d.items || [],
        checks: d.checks || {}, note: d.note || '', weights: d.weights || null,
        pickedId: d.pickedId || null,
      });
      /* Аналіз не зберігаємо, а перераховуємо: він дешевий, а зберігати
         результат і ризикувати розбіжністю з даними — ні. */
      if (state.items.length >= 2 && d.maxStage > 1) {
        state.analysis = Engine.analyze(scenario(), state.items, state.ctx, state.weights);
        state.maxStage = Math.min(d.maxStage, 3);
      }
    }

    $('#btn-settings').addEventListener('click', () => { renderSettings(); $('#settings-modal').hidden = false; });
    $('#btn-close-settings').addEventListener('click', () => { $('#settings-modal').hidden = true; });
    $('#btn-archive').addEventListener('click', () => { renderArchive(); $('#archive-modal').hidden = false; });
    $('#btn-close-archive').addEventListener('click', () => { $('#archive-modal').hidden = true; });
    $('#btn-close-digest').addEventListener('click', () => { $('#digest-modal').hidden = true; });

    document.querySelectorAll('.modal-back').forEach((back) => {
      back.addEventListener('click', (e) => { if (e.target === back) back.hidden = true; });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.modal-back').forEach((m) => { m.hidden = true; });
    });

    /* Вставка таблиці з Excel. Слухач один на весь документ і ставиться
       раз: етап 1 перемальовується щоразу, коли людина править клітинку,
       і слухач на картці множився б. Вставку в поле введення не чіпаємо —
       там людина вставляє назву, а не таблицю. */
    document.addEventListener('paste', (e) => {
      if (state.stage !== 1 || !state.scenarioId) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!/[\t;|]|,.*,/.test(text)) return;   // схоже на таблицю, а не на одне слово
      e.preventDefault();
      applyTable(text, 'буфера обміну');
    });

    bindDrop();

    updateBadge();
    updateArchiveBadge();
    goTo(d && d.stage && d.stage <= state.maxStage ? d.stage : 1);
  }

  init();
})();
