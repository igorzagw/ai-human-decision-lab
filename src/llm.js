/* ============================================================================
   llm.js — текстовий шар. Працює через Groq API просто з браузера
   (CORS відкритий, тож проксі не потрібен).

   Розподіл обов'язків тут жорсткий і навмисний:
     engine.js  — РАХУЄ. Цифри беруться лише звідти.
     llm.js     — ПОЯСНЮЄ і ЗАПЕРЕЧУЄ. Жодного числа не вигадує.

   Причина проста: мовна модель переконливо помиляється в арифметиці, і
   перевірити її на захисті неможливо. Розрахунок має бути відтворюваним,
   а формулювання — живим. Тому ділимо роботу за сильними сторонами.

   Без ключа застосунок не ламається: пояснення складається локально
   з тих самих чисел. Гірше стилістично — але воно завжди є.
   ========================================================================== */

'use strict';

const LLM = (() => {

  const ENDPOINT = 'https://api.groq.com/openai/v1';
  const LS_KEY = 'ahdl.groq.key';
  const LS_MODEL = 'ahdl.groq.model';
  const LS_ENABLED = 'ahdl.llm.enabled';

  /* Моделі, які не вміють у діалог: розпізнавання мови, синтез, класифікатори.
     Відсіюємо їх зі списку, щоб людина не обрала те, що поверне помилку. */
  const NOT_CHAT = /whisper|tts|guard|embed|safeguard|prompt-?guard/i;

  /* Порядок переваги. Llama 3.3 і 3.1 пішли з безкоштовного тарифу Groq
     16 серпня 2026 — лишати їх першими означало б віддавати помилку тим,
     хто не обирав модель руками. Список усе одно приходить з API, тож ці
     назви лише задають, що підставити за замовчуванням. */
  const PREFERRED = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'];

  const store = {
    get key()      { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } },
    set key(v)     { try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch {} },
    get model()    { try { return localStorage.getItem(LS_MODEL) || ''; } catch { return ''; } },
    set model(v)   { try { localStorage.setItem(LS_MODEL, v); } catch {} },
    get enabled()  { try { return localStorage.getItem(LS_ENABLED) !== '0'; } catch { return true; } },
    set enabled(v) { try { localStorage.setItem(LS_ENABLED, v ? '1' : '0'); } catch {} },
  };

  const hasKey = () => Boolean(store.key);
  const isOn = () => hasKey() && store.enabled;

  /* ─────────────────────────── мережа ─────────────────────────── */

  function humanError(status, body) {
    if (status === 401) return 'Groq не прийняв ключ. Перевірте, чи скопійований він повністю.';
    if (status === 429) return 'Ліміт запитів Groq вичерпано. Зачекайте хвилину або змініть модель.';
    if (status === 404) return 'Обрана модель недоступна. Оновіть список моделей у налаштуваннях.';
    if (status === 413) return 'Забагато даних для одного запиту. Зменште кількість об\'єктів.';
    if (status >= 500)  return 'Groq тимчасово недоступний. Розрахунки це не зупиняє.';
    return 'Помилка Groq (' + status + '): ' + String(body).slice(0, 200);
  }

  async function listModels() {
    if (!hasKey()) throw new Error('Спершу введіть ключ Groq.');
    const res = await fetch(ENDPOINT + '/models', {
      headers: { Authorization: 'Bearer ' + store.key },
    });
    if (!res.ok) throw new Error(humanError(res.status, await res.text()));
    const json = await res.json();
    return (json.data || [])
      .filter((m) => m.active !== false && !NOT_CHAT.test(m.id))
      .map((m) => ({ id: m.id, owner: m.owned_by, context: m.context_window }))
      .sort((a, b) => {
        const ia = PREFERRED.indexOf(a.id);
        const ib = PREFERRED.indexOf(b.id);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a.id.localeCompare(b.id);
      });
  }

  async function chat(messages, { temperature = 0.4, maxTokens = 1100 } = {}) {
    if (!isOn()) throw new Error('LLM вимкнено або немає ключа.');
    const model = store.model || PREFERRED[0];

    const res = await fetch(ENDPOINT + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + store.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });

    if (!res.ok) throw new Error(humanError(res.status, await res.text()));
    const json = await res.json();
    return (json.choices?.[0]?.message?.content || '').trim();
  }

  /* ───────────────────── що саме йде в мережу ─────────────────────
     Формуємо стислу зведення, а не сирі дані. Людина має бачити
     рівно те, що буде надіслано, тому ця функція публічна і її
     результат показується в інтерфейсі перед відправкою. */

  function digest(scenario, ctx, analysis) {
    const lines = [];
    lines.push('ЗАДАЧА: ' + scenario.title);
    lines.push('ПИТАННЯ: ' + scenario.question);
    lines.push('ЯК РАХУВАЛОСЯ: ' + scenario.method);
    lines.push('');
    lines.push('УМОВИ:');
    scenario.context.forEach((f) => {
      lines.push('  ' + f.label + ': ' + ctx[f.key] + ' ' + (f.unit || ''));
    });

    lines.push('');
    lines.push('КРИТЕРІЇ ОЦІНКИ (кожен у шкалі 0-10):');
    scenario.criteria.forEach((c) => lines.push('  ' + c.label + ' — ' + c.explain));

    if (analysis.diagnostics.length) {
      lines.push('');
      lines.push('ЗАУВАЖЕННЯ ДО ДАНИХ:');
      analysis.diagnostics.forEach((d) => lines.push('  [' + d.level + '] ' + d.text));
    }

    analysis.variants.forEach((v, i) => {
      lines.push('');
      lines.push('ВАРІАНТ ' + (i + 1) + ': ' + v.strategy.name);
      lines.push('  суть: ' + v.strategy.summary);
      lines.push('  важливості критеріїв: ' + Object.entries(v.strategy.weights)
        .map(([k, w]) => k + '=' + w).join(', '));
      lines.push('  відомий ризик: ' + v.strategy.tradeoff);
      v.metrics.forEach((m) => {
        lines.push('  ' + m.label + ': ' + m.value + (m.unit ? ' ' + m.unit : '') +
                   (m.of !== undefined ? ' із ' + m.of : '') + (m.note ? ' (' + m.note + ')' : ''));
      });
      lines.push('  ' + v.note);

      if (v.chosen) {
        /* Для програми робочих місць число місць і зарплата важливіші за
           саму вартість: без них модель не зможе пояснити, чим варіанти
           різняться, і почне переказувати лише гроші. */
        const detail = (c) => c.item.jobs !== undefined
          ? c.item.jobs + ' місць, ' + c.item.cost + ' млн, зарплата ' + c.item.wage + ' тис., бал ' + c.score
          : c.item.cost + ' млн, бал ' + c.score;
        lines.push('  у плані: ' + (v.chosen.map((c) => c.item.name + ' (' + detail(c) + ')').join('; ') || 'нічого'));
        const out = v.rejected.slice(0, 5).map((c) => c.item.name + ' (бал ' + c.score + ')').join('; ');
        if (out) lines.push('  не увійшли: ' + out);
      }
      if (v.allocation) {
        lines.push('  розподіл: ' + v.allocation
          .map((a) => a.item.name + ' — ' + a.money + ' млн (' + a.share + '%), бал ' + a.score).join('; '));
      }
      if (v.links) {
        lines.push('  найслабша ланка: ' + v.weakest.item.name + ', вільно ' + v.weakest.free + ' місць');
        lines.push('  вільні місця по ланках: ' + v.links
          .map((l) => l.item.name + ' — ' + l.free).join('; '));
        if (v.queue && v.queue.length) {
          /* Ціна місця на кожному кроці — те, без чого модель не зрозуміє,
             чому перші місця дешеві, а останні ні. */
          lines.push('  драбина підняття межі: ' + v.queue
            .map((q, i) => (i + 1) + ') розширити ' + q.name + ' на ' + q.need +
                 ' місць до межі ' + q.to + ' осіб — ' + q.cost + ' млн, тобто ' +
                 q.per + ' тис. грн за одне місце')
            .join('; '));
        }
      }
    });

    return lines.join('\n');
  }

  /* ─────────────────────────── промпти ─────────────────────────── */

  const SYSTEM = `Ти пояснюєш рішення про відбудову української громади. Пишеш українською,
просто і коротко — так, щоб зрозумів старшокласник. Короткі речення, жодного канцеляриту.

ЖОРСТКЕ ПРАВИЛО: усі числа вже обчислені окремим алгоритмом і наведені у вхідних даних.
Ти НЕ рахуєш, НЕ перевіряєш арифметику і НЕ вигадуєш нових цифр. Можна лише цитувати наведені.
Якщо для висновку бракує даних — так і кажи, а не вгадуй.

Твоя робота — пояснити, ЩО означають ці числа і ЧОГО вони не показують.
Не хвали жоден варіант. Не пиши «варіант оптимальний»: що краще — залежить від
цінностей, а їх обирає людина, не модель.
Не пиши загальних фраз на кшталт «важливо враховувати всі фактори».`;

  async function explainAnalysis(scenario, ctx, analysis) {
    const user = `Ось результат розрахунку. Поясни його людині, яка ухвалює рішення.

${digest(scenario, ctx, analysis)}

Відповідай коротко, у такій структурі (markdown, без заголовка на початку):

**Що показує розрахунок**
2 речення, спираючись на числа вище.

**Чим варіанти різняться**
По одному рядку на варіант: що він обирає і чим за це платить.

**Чого модель не бачить**
3 пункти, конкретні для цієї ситуації. Наприклад: суд за землю, умови донора,
незгода мешканців, брак підрядників, сезонність робіт, міни.

**Питання до людини**
2 питання, де відповідь залежить від цінностей, а не від розрахунку.`;

    return chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ]);
  }

  async function critiqueDecision(scenario, ctx, analysis, chosenVariant, checks, note) {
    /* Питання й відповідь ідуть парою: без формулювання питання відповідь
       на кшталт «Частково» не означає нічого. */
    const answered = HUMAN_CHECKS
      .filter((q) => (checks || {})[q.key] !== undefined)
      .map((q) => '  ' + q.label + ' → ' + checkAnswerLabel(q, checks[q.key]))
      .join('\n');

    const user = `Людина обрала варіант «${chosenVariant.strategy.name}» і зараз ухвалює остаточне рішення.

${digest(scenario, ctx, analysis)}

ЯК ЛЮДИНА ПЕРЕВІРИЛА РЕКОМЕНДАЦІЮ:
${answered || '  (перевірку не заповнено)'}

КОМЕНТАР ЛЮДИНИ: ${note ? note : '(порожньо)'}

Твоє завдання — НЕ погодитися, а заперечити. Коротко, у такій структурі:

**Найсильніше заперечення**
2-3 речення: чому цей вибір може виявитися помилковим. Спирайся на числа вище.

**Кого це лишає позаду**
Назви конкретні групи людей і чим саме вони платять.

**Що перевірити до підписання**
3 пункти. Кожен — дія на тиждень, а не побажання.

**Коли переглянути рішення**
1-2 конкретні тригери: подія або цифра.

Якщо людина лишила перевірку незаповненою або позначила сумніви — скажи прямо.`;

    return chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ], { temperature: 0.55 });
  }

  /* ─────────────── локальні пояснення (без мережі) ───────────────
     Не «заглушка», а робочий режим: та сама структура, зібрана
     з тих самих чисел. Саме цей шлях працює на захисті, якщо
     впаде інтернет або скінчиться ліміт. */

  function explainLocally(scenario, ctx, analysis) {
    const L = [];
    L.push('**Що показує розрахунок**');
    L.push('');
    L.push(scenario.method + '. Пораховано у вашому браузері за ' + analysis.elapsedMs + ' мс.');

    const warn = analysis.diagnostics.filter((d) => d.level !== 'info');
    if (warn.length) {
      L.push('');
      warn.forEach((d) => L.push('- ' + d.text));
    }

    L.push('');
    L.push('**Чим варіанти різняться**');
    L.push('');
    analysis.variants.forEach((v) => {
      const m = v.metrics[0];
      L.push('- **' + v.strategy.name + '.** ' + v.strategy.summary +
             ' (' + m.label.toLowerCase() + ': ' + m.value + (m.unit ? ' ' + m.unit : '') + ')' +
             ' Ризик: ' + v.strategy.tradeoff);
    });

    L.push('');
    L.push('**Чого модель не бачить**');
    L.push('');
    L.push('- Суд за землю: юридична тяганина зупиняє роботи надовше за брак грошей.');
    L.push('- Умови донорів: гроші часто не можна перекинути на інший напрям.');
    L.push('- Брак підрядників: у прифронтових громадах це вужче місце, ніж бюджет.');
    L.push('- Незгода мешканців: план, який вважають несправедливим, саботують.');

    L.push('');
    L.push('_Складено локально, без мовної моделі. Числа в обох режимах однакові._');
    return L.join('\n');
  }

  function critiqueLocally(scenario, ctx, analysis, variant, checks) {
    const L = [];
    const doubts = Object.entries(checks || {}).filter(([, v]) => v === 1);
    const empty = HUMAN_CHECKS.filter((q) => !(checks || {})[q.key]);

    L.push('**Ціна цього вибору**');
    L.push('');
    L.push(variant.strategy.tradeoff);

    if (empty.length) {
      L.push('');
      L.push('**Незакрита перевірка**');
      L.push('');
      L.push('Питань без відповіді: ' + empty.length + '. Рішення спирається лише на розрахунок, ' +
             'а розрахунок не знає про людей.');
    }

    if (doubts.length) {
      L.push('');
      L.push('**Ваші сумніви**');
      L.push('');
      doubts.forEach(([k, v]) => {
        const q = HUMAN_CHECKS.find((c) => c.key === k);
        if (q) L.push('- ' + q.label + ' — **' + checkAnswerLabel(q, v) + '**');
      });
    }

    L.push('');
    L.push('**Що перевірити до підписання**');
    L.push('');
    L.push('- Звірити кошториси з нинішніми цінами: дані старші за півроку зазвичай занижені.');
    L.push('- Переконатися, що на кожен пункт є підрядник.');
    L.push('- Показати план тим, хто до нього не потрапив.');

    L.push('');
    L.push('_Складено локально, без мовної моделі._');
    return L.join('\n');
  }

  /* ─────────────────────── публічний інтерфейс ─────────────────────── */

  async function explain(scenario, ctx, analysis) {
    if (!isOn()) return { text: explainLocally(scenario, ctx, analysis), source: 'local' };
    try {
      return { text: await explainAnalysis(scenario, ctx, analysis), source: 'groq', model: store.model };
    } catch (err) {
      /* Падіння мережі не має зупиняти роботу: віддаємо локальний текст
         і чесно пишемо, що саме пішло не так. */
      return { text: explainLocally(scenario, ctx, analysis), source: 'local', error: err.message };
    }
  }

  async function critique(scenario, ctx, analysis, variant, checks, note) {
    if (!isOn()) return { text: critiqueLocally(scenario, ctx, analysis, variant, checks), source: 'local' };
    try {
      return { text: await critiqueDecision(scenario, ctx, analysis, variant, checks, note), source: 'groq', model: store.model };
    } catch (err) {
      return { text: critiqueLocally(scenario, ctx, analysis, variant, checks), source: 'local', error: err.message };
    }
  }

  return { store, hasKey, isOn, listModels, explain, critique, digest, PREFERRED };
})();
