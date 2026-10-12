/* ============================================================================
   engine.js — обчислювальне ядро. Працює повністю у браузері,
   дані громади нікуди не надсилаються.

   Уся математика застосунку — це три кроки:

     1. Кожен критерій перетворюється на оцінку 0–10.
     2. Бал = середнє зважене цих оцінок (теж 0–10).
     3. Ресурс розподіляється за балами, від найвищого до найнижчого.

   Свідомо просто. Складніші методи (динамічне програмування, гранична
   корисність) дають точніший результат на кілька відсотків, але їх
   неможливо пояснити людині, яка ухвалює рішення — а непояснений
   розрахунок не допомагає вирішувати, він лише тисне авторитетом.
   ========================================================================== */

'use strict';

const Engine = (() => {

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  /* Українське відмінювання після числа: 1 напрям, 2 напрями, 5 напрямів. */
  const plural = (n, one, few, many) => {
    const d = Math.abs(n) % 10;
    const h = Math.abs(n) % 100;
    if (d === 1 && h !== 11) return one;
    if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
    return many;
  };

  const round = (x, n = 1) => {
    const k = 10 ** n;
    return Math.round(x * k) / k;
  };

  /* Число всередині речення має виглядати так само, як у показниках:
     інакше в одному рядку сусідять «168.5» і «258,5». */
  const num = (x) => round(x).toLocaleString('uk-UA');

  /* Гроші й строки у масштабі великого міста.

     Застосунок писався під громаду на 15 тисяч, де суми — десятки
     мільйонів, а строки — місяці. Для міста на 360 тисяч ті самі формули
     дають «20 605 млн» і «2061 міс»: числа правильні, та прочитати їх
     неможливо, і головне — неможливо відчути. «20,6 млрд» і «172 роки»
     кажуть те саме, але одразу зрозуміло, що бюджету немає. */

  const money = (mln) => (Math.abs(mln) >= 1000
    ? num(mln / 1000) + ' млрд'
    : num(mln) + ' млн');

  /* Частка, яку бюджет покриває. Нуль відсотків — неправда: гроші є, їх
     просто мало. «Менше 1%» — правда, і вона важливіша за округлення. */
  const share = (part, whole) => {
    if (whole <= 0) return '100%';
    const pct = (part / whole) * 100;
    if (pct > 0 && pct < 1) return 'менше 1%';
    return Math.round(pct) + '%';
  };

  /* ── крок 1: число з таблиці -> оцінка 0–10 ─────────────────────────── */

  /** Сире значення критерію. Майже завжди це поле таблиці, але для
   *  «вільного місця» його треба порахувати: місткість мінус ті, хто вже живе. */
  function rawValue(item, criterion, ctx) {
    if (criterion.from === 'free') return Math.max(0, item.capacity - ctx.current);
    /* Ціна одного робочого місця: саме вона порівнює напрями між собою.
       «14 млн» ні про що не каже, поки не відомо, скільком людям це дасть
       роботу — теплиці за 14 млн на 35 місць дешевші за сервіс техніки
       за 4 млн на 9 місць. Вартість у млн, місць — осіб, тож ×1000
       переводить у тисячі гривень на місце. */
    if (criterion.from === 'costPerJob') {
      /* Захист лише від ділення на нуль. Колишній Math.max(1, jobs) робив
         більше: він підміняв будь-яке значення менше одиниці, і через це
         бал залежав від того, в яких одиницях рахують — тисячах осіб чи
         особах. Модель не має знати, велике місто чи маленьке село. */
      const jobs = Number(item.jobs) || 0;
      if (jobs <= 0) return 0;
      return round(((Number(item.cost) || 0) * 1000) / jobs);
    }
    return Number(item[criterion.from]) || 0;
  }

  /** Переведення у шкалу 0–10.
   *  relative та inverse порівнюють об'єкт із рештою списку: оцінка має сенс
   *  лише поряд з іншими. Якщо всі значення однакові, різниці немає — усі
   *  отримують 5, і критерій просто не впливає на порядок. */
  function toScore(value, scale, all) {
    if (scale === 'direct') return clamp(value, 0, 10);
    if (scale === 'worse')  return clamp((100 - value) / 10, 0, 10);

    const max = Math.max(...all);
    const min = Math.min(...all.filter((v) => v > 0), max);

    if (scale === 'relative') {
      if (max <= 0) return 5;
      return clamp((value / max) * 10, 0, 10);
    }
    // inverse: менше — краще
    if (value <= 0) return 10;
    if (min <= 0) return 5;
    return clamp((min / value) * 10, 0, 10);
  }

  /* ── крок 2: оцінки -> бал ──────────────────────────────────────────── */

  function scoreItems(scenario, items, ctx, weights) {
    const w = {};
    scenario.criteria.forEach((c) => {
      w[c.key] = Math.max(0, Number(weights?.[c.key] ?? c.weight));
    });
    const wTotal = sum(Object.values(w)) || 1;

    /* Колонки сирих значень потрібні цілком, бо relative та inverse
       порівнюють кожен об'єкт із максимумом і мінімумом усього списку. */
    const columns = {};
    scenario.criteria.forEach((c) => {
      columns[c.key] = items.map((it) => rawValue(it, c, ctx));
    });

    return items.map((item, i) => {
      const parts = scenario.criteria.map((c) => {
        const raw = columns[c.key][i];
        const score = toScore(raw, c.scale, columns[c.key]);
        return {
          key: c.key,
          label: c.label,
          raw,
          score: round(score),
          weight: w[c.key],
          share: round((score * w[c.key]) / wTotal, 2),
        };
      });

      return {
        item,
        index: i,
        parts,
        weightTotal: wTotal,
        score: round(sum(parts.map((p) => p.score * p.weight)) / wTotal),
      };
    });
  }

  /* ── крок 3, варіант А: набираємо план, поки вистачає грошей ────────── */

  function planPriority(scenario, items, ctx, strategy) {
    const scored = scoreItems(scenario, items, ctx, strategy.weights);
    const ranked = [...scored].sort((a, b) => b.score - a.score);

    /* Ідемо згори вниз і беремо все, що вміщується в залишок.
       Якщо об'єкт не вліз — не зупиняємось, а пробуємо наступний:
       після дорогого мосту цілком може влізти дешеве укриття. */
    const chosen = [];
    let left = ctx.budget;
    for (const s of ranked) {
      if (s.item.cost <= left) {
        chosen.push(s);
        left = round(left - s.item.cost, 2);
      }
    }

    const chosenIds = new Set(chosen.map((s) => s.index));
    const rejected = ranked.filter((s) => !chosenIds.has(s.index));

    return {
      strategy,
      ranked,
      chosen,
      rejected,
      /* Відповідь варіанта — склад плану, без порядку: порядок це вже «як
         рахували», а не «що обрали». Потрібна, щоб побачити, коли три
         варіанти кажуть одне й те саме. */
      answer: chosen.map((s) => s.index).sort((a, b) => a - b).join(','),
      metrics: [
        { label: 'Об\'єктів у плані', value: chosen.length, of: items.length },
        { label: 'Витрачено', value: round(ctx.budget - left), unit: 'млн', of: ctx.budget },
        { label: 'Залишиться', value: left, unit: 'млн' },
      ],
      /* Коли план не порожній, додавати нічого: метрики вище вже все сказали,
         а однаковий підпис у трьох картках — просто шум. */
      note: chosen.length ? '' : 'Жоден об\'єкт не вміщується в бюджет.',
    };
  }

  /* ── крок 3, варіант Б: ділимо гроші пропорційно до балів ───────────── */

  function planBudget(scenario, items, ctx, strategy) {
    const scored = scoreItems(scenario, items, ctx, strategy.weights);
    const total = sum(scored.map((s) => s.score)) || 1;

    const allocation = scored
      .map((s) => {
        const share = s.score / total;
        const money = ctx.budget * share;
        return {
          ...s,
          share: round(share * 100),
          money: round(money),
          /* Наочний переклад грошей у зміну стану: приблизний, і модель
             прямо про це каже. Точна ціна пункту залежить від підрядника. */
          stateBefore: s.item.state,
          stateAfter: round(clamp(s.item.state + (money / Math.max(ctx.budget, 1)) * 100, 0, 100)),
        };
      })
      /* Сортуємо за балом, а не за грошима. Гроші в полі money вже
         округлені до 0,1 млн, і на невеликих бюджетах два сусідні
         значення після округлення збігаються — порядок тоді перестає
         відповідати часткам, і сфера з 15,6% стає нижче за сферу з 15,2%.
         Бал — те саме відношення без округлення, бо money = бюджет ×
         бал ÷ сума балів. */
      .sort((a, b) => b.score - a.score);

    const top = allocation[0];
    return {
      strategy,
      ranked: [...scored].sort((a, b) => b.score - a.score),
      allocation,
      answer: allocation.slice().sort((a, b) => a.index - b.index)
        .map((a) => a.index + ':' + a.share).join(','),
      metrics: [
        { label: 'Найбільша частка', value: top ? top.share : 0, unit: '%',
          note: top ? top.item.name : '' },
        { label: 'Розподілено', value: round(sum(allocation.map((a) => a.money))), unit: 'млн', of: ctx.budget },
        /* Порог «щось отримала» — частка бюджету, а не 0,05 млн: абсолютна
           межа означала б, що та сама сфера в місті «отримала», а в селі
           «ні», хоч частка однакова. */
        { label: 'Сфер у розподілі',
          value: allocation.filter((a) => a.money >= ctx.budget * 0.001).length, of: items.length },
      ],
      note: '',
    };
  }

  /* ── крок 3, варіант В: межу задає найслабша ланка ──────────────────── */

  function planReturn(scenario, items, ctx, strategy) {
    const scored = scoreItems(scenario, items, ctx, strategy.weights);

    const links = scored.map((s) => ({
      ...s,
      free: Math.max(0, s.item.capacity - ctx.current),
    }));

    /* Найслабша ланка — це не «найгірша за балом», а буквально та,
       де найменше вільних місць. Саме вона фізично обмежує громаду. */
    const weakest = links.reduce((a, b) => (a.free <= b.free ? a : b));
    const demand = ctx.wantReturn;

    const horizon = Math.max(1, ctx.horizon || 12);

    const capacityNow = Math.min(demand, weakest.free);
    const gap = Math.max(0, demand - capacityNow);

    /* ── Драбина підняття межі ────────────────────────────────────────

       Головне тут — ціна одного місця НЕ стала. Поки вузьке місце одне,
       платимо лише за нього: тепло на 15 000 вільних місць розширюється
       по 35 тис. грн за місце. Коли тепло дотягнеться до житла й роботи
       (25 000), вузькими стануть три ланки — і кожне наступне місце вже
       коштує як сума трьох: 95 тис. Далі чотири, п'ять.

       Виходить драбина, і це не ускладнення моделі, а та сама заявлена
       думка «межу задає найслабша ланка», доведена до кінця. Попередня
       версія ділила повну потребу на всіх людей і брала середню ціну —
       через це наявні гроші недооцінювалися в кілька разів: за 120 млн
       виходило 815 місць замість справжніх 3 428. */

    const rungs = links
      .map((l) => ({ name: l.item.name, free: l.free, per: l.item.costUp / 1000 }))
      .sort((a, b) => a.free - b.free);

    const ladder = [];
    let border = capacityNow;
    let next = 0;
    while (border < demand) {
      const active = rungs.filter((r) => r.free <= border);
      const per = sum(active.map((r) => r.per));
      /* Ланки, що вже позаду, пропускаємо — інакше крок нульової висоти
         зациклив би обхід на ланках з однаковою кількістю вільних місць. */
      while (next < rungs.length && rungs[next].free <= border) next++;
      const target = Math.min(next < rungs.length ? rungs[next].free : demand, demand);
      const places = target - border;
      if (places <= 0 || per <= 0) break;
      ladder.push({
        to: target,
        places,
        per,
        cost: round(places * per, 2),
        names: active.map((r) => r.name),
      });
      border = target;
    }

    const fullCost = round(sum(ladder.map((s) => s.cost)));
    const stepNow = ladder[0] || null;      // крок, на якому громада стоїть
    const missingMoney = round(Math.max(0, fullCost - ctx.budget));
    const budgetCovers = share(ctx.budget, fullCost);

    /* Скільки місць дають наявні гроші — рухаємось драбиною, а не множимо
       бюджет на середню ціну. */
    let left = ctx.budget;
    let reachable = capacityNow;
    for (const s of ladder) {
      if (left <= 0) break;
      if (left >= s.cost) { left = round(left - s.cost, 2); reachable = s.to; }
      else { reachable += Math.floor(left / s.per); left = 0; }
    }
    const addedByBudget = Math.max(0, reachable - capacityNow);
    const perMonth = Math.round(addedByBudget / horizon);

    /* Скільком бюджетам такого розміру дорівнює потреба. Саме це число
       попередня версія видавала за строк у роках, розтягуючи разову суму
       на двісті років безперервного фінансування. Бюджетів — правда,
       роки — вигадка: гроші скінчаться на горизонті. */
    const budgetsNeeded = ctx.budget > 0 ? Math.ceil(fullCost / ctx.budget) : 0;

    /* Черга покращень — це кроки драбини: що розширюємо, доки і якою
       ціною. Назвати «розширити тепло на 140 000 місць» було б
       неправдою: далі за 25 000 тепло вже не вузьке місце. */
    const queue = ladder.map((s) => ({
      /* Коротка назва для таблиці й повна — для протоколу та моделі:
         на останніх кроках вузьких ланок сім-вісім, і перелік із восьми
         назв розсуває колонку так, що цифри вже не прочитати. */
      name: s.names.length <= 2 ? s.names.join(' + ')
        : s.names.slice(0, 2).join(' + ') + ' і ще ' + (s.names.length - 2),
      names: s.names,
      to: s.to,
      need: s.places,
      cost: s.cost,
      per: round(s.per * 1000),
    }));

    const top = queue.slice(0, 3);

    let accept, plan, metrics;


    if (strategy.id === 'all') {
      /* Питання цієї картки: якщо повернути всіх зараз — чого бракує
         і скільки коштує це закрити. */
      accept = demand;
      plan = 'Зараз громада витримує ' + num(capacityNow) + ' осіб — стільки, скільки вільно у «' +
             weakest.item.name + '». Якщо повернути всіх ' + num(demand) + ', то ' + num(gap) +
             ' людей приїдуть у те, чого немає.' +
             (stepNow
               ? ' Найближчий крок — підняти межу до ' + num(stepNow.to) + ' осіб: ' +
                 'розширити «' + stepNow.names.join(' + ') + '» на ' + num(stepNow.places) +
                 ' місць за ' + money(stepNow.cost) + ' (по ' + num(stepNow.per * 1000) +
                 ' тис. грн за місце). Далі вузьких ланок стає більше, і місце дорожчає. ' +
                 'Щоб прийняти всіх ' + num(demand) + ', потрібно ' + money(fullCost) +
                 ' — наявні ' + money(ctx.budget) + ' покривають ' + budgetCovers +
                 (missingMoney > 0 ? ', бракує ще ' + money(missingMoney) + '.' : '.')
               : '');
      metrics = [
        { label: 'Можна прийняти зараз', value: capacityNow, unit: 'осіб', of: demand,
          note: 'межу задає «' + weakest.item.name + '»' },
        { label: 'Приїдуть у нікуди', value: gap, unit: 'осіб' },
        { label: 'Треба вкласти на всіх', value: money(fullCost),
          note: missingMoney > 0 ? 'бюджет покриває ' + budgetCovers : 'бюджету вистачає' },
        { label: 'Найближчий крок', value: stepNow ? stepNow.names.join(' + ') : '—',
          note: stepNow ? 'до ' + num(stepNow.to) + ' осіб за ' + money(stepNow.cost) : '' },
      ];

    } else if (strategy.id === 'step') {
      /* Питання цієї картки: скільки людей, за який строк і якою ціною.
         Темп визначають гроші: скільки громада вкладає щомісяця,
         поділене на ціну одного місця. */
      accept = reachable;

      plan = 'Перший етап — ' + num(capacityNow) + ' осіб одразу, більше не витримує «' +
             weakest.item.name + '». Наявні ' + money(ctx.budget) + ' піднімають межу ще на ' +
             num(addedByBudget) + ' ' + plural(addedByBudget, 'місце', 'місця', 'місць') +
             (stepNow ? ', бо на цьому кроці місце коштує ' + num(stepNow.per * 1000) +
               ' тис. грн — розширювати треба лише «' + stepNow.names.join(' + ') + '»' : '') +
             '. Разом за ' + horizon + ' міс громада приймає ' + num(reachable) + ' осіб із ' +
             num(demand) + (perMonth > 0 ? ', тобто близько ' + num(perMonth) +
               ' осіб на місяць' : '') + '.' +
             (missingMoney > 0
               ? ' Щоб прийняти всіх, потрібно ще ' + money(missingMoney) + ' — це ' +
                 budgetsNeeded + ' ' + plural(budgetsNeeded, 'такий бюджет', 'такі бюджети',
                 'таких бюджетів') + '. Строк залежить від того, скільки їх виділять, ' +
                 'а не від розрахунку.'
               : ' Бюджету вистачає на всіх охочих.');
      metrics = [
        { label: 'Перший етап', value: capacityNow, unit: 'осіб', note: 'одразу, без вкладень' },
        { label: 'Додає бюджет', value: addedByBudget, unit: 'осіб',
          note: stepNow ? 'по ' + num(stepNow.per * 1000) + ' тис. грн за місце' : '' },
        { label: 'Разом за ' + horizon + ' міс', value: reachable, unit: 'осіб', of: demand },
        { label: 'Щоб прийняти всіх', value: missingMoney > 0 ? money(missingMoney) : 'вистачає',
          note: missingMoney > 0 ? budgetsNeeded + ' ' +
            plural(budgetsNeeded, 'такий бюджет', 'такі бюджети', 'таких бюджетів') : '' },
      ];

    } else {
      /* Питання цієї картки: спершу вкладення, потім повернення.
         Скільки треба, куди саме, коли можна починати і коли приймемо всіх. */
      /* Чи закриває бюджет хоча б перший крок — ось від чого залежить,
         коли взагалі можна починати повернення. */
      const firstStepCovered = stepNow ? ctx.budget >= stepNow.cost : true;
      const firstStepShare = stepNow ? share(ctx.budget, stepNow.cost) : '100%';

      accept = reachable;
      plan = 'Спершу вкладення, повернення — після. Перший крок: розширити «' +
             (stepNow ? stepNow.names.join(' + ') : '—') + '» на ' +
             (stepNow ? num(stepNow.places) : '0') + ' місць за ' +
             (stepNow ? money(stepNow.cost) : '0') + ' — це підніме межу до ' +
             (stepNow ? num(stepNow.to) : num(capacityNow)) + ' осіб. ' +
             (firstStepCovered
               ? 'Наявних ' + money(ctx.budget) + ' на цей крок вистачає, тож починати можна в межах горизонту.'
               : 'Наявних ' + money(ctx.budget) + ' вистачає лише на ' + firstStepShare +
                 ' цього кроку, тож навіть перше вузьке місце не розшивається повністю.') +
             ' Уся підготовка до ' + num(demand) + ' осіб — ' + money(fullCost) +
             (missingMoney > 0 ? ', тобто ще ' + money(missingMoney) + ' понад наявне.' : '.');
      metrics = [
        { label: 'Перший крок', value: stepNow ? stepNow.names.join(' + ') : '—',
          note: stepNow ? money(stepNow.cost) + ' до межі ' + num(stepNow.to) + ' осіб' : '' },
        { label: 'Бюджет покриває крок', value: firstStepShare,
          note: firstStepCovered ? 'можна починати' : 'крок не закривається' },
        { label: 'Межа після вкладень', value: reachable, unit: 'осіб', of: demand },
        { label: 'Уся підготовка', value: money(fullCost),
          note: 'кроків: ' + ladder.length },
      ];
    }

    return {
      strategy,
      ranked: [...links].sort((a, b) => b.score - a.score),
      links: [...links].sort((a, b) => a.free - b.free),
      weakest,
      queue,
      ladder,
      /* Відповіді тут немає свідомо. У цій задачі межу задає фізика —
         вільні місця й ціна розширення, — і важливості критеріїв на неї
         не впливають. Три варіанти різняться не розрахунком, а політикою:
         ризикнути, рухатися поступово чи спершу вкластися. Тож порівнювати
         їх між собою на «однаковість» немає сенсу: вони однакові за
         числами й різні за рішенням. Про це сказано прямо в діагностиці. */
      answer: null,
      metrics,
      note: plan,
    };
  }

  /* ── крок 3, варіант Г: програма робочих місць ───────────────────────

     Набір такий самий, як у «що відбудовувати першим»: згори вниз, поки
     вистачає грошей. Різниця — у підсумку. Тут громаду цікавить не
     «скільки об'єктів», а чотири різні відповіді на питання «що ми з
     цього маємо»: скільки людей, яка в них плата, якою ціною місце і
     чи повертаються гроші назад у бюджет.

     Про податки варто сказати окремо. Із зарплати стягується ПДФО 18%,
     і до бюджетів громад зараховується 64% цього податку (решта йде
     вище). Військовий збір до місцевого бюджету не потрапляє, тому його
     тут немає. Розрахунок свідомо приблизний: він показує порядок
     величини — чи відіграються вкладення за три роки чи за тридцять, —
     а не точну суму надходжень. */

  const PIT_RATE = 0.18;         // ПДФО із зарплати
  /* 64% — норма 2026 року. Це тимчасовий виняток: базовий норматив
     Бюджетного кодексу — 60%, і уряд пропонує повернутися до нього.
     Якщо норму змінять, це число треба виправити, інакше окупність
     рахуватиметься за правилами, яких уже немає. */
  const PIT_LOCAL_SHARE = 0.64;

  function planJobs(scenario, items, ctx, strategy) {
    const scored = scoreItems(scenario, items, ctx, strategy.weights);
    const ranked = [...scored].sort((a, b) => b.score - a.score);

    const chosen = [];
    let left = ctx.budget;
    for (const s of ranked) {
      if (s.item.cost <= left) {
        chosen.push(s);
        left = round(left - s.item.cost, 2);
      }
    }

    const chosenIds = new Set(chosen.map((s) => s.index));
    const rejected = ranked.filter((s) => !chosenIds.has(s.index));

    const spent = round(ctx.budget - left);
    const jobs = sum(chosen.map((s) => s.item.jobs));
    /* Фонд зарплат за рік у млн: місць × тис. грн на місяць × 12 ÷ 1000. */
    const payrollYear = round(sum(chosen.map((s) => s.item.jobs * s.item.wage)) * 12 / 1000);
    const taxes = round(payrollYear * PIT_RATE * PIT_LOCAL_SHARE, 2);
    const payback = taxes > 0 ? round(spent / taxes, 1) : 0;
    const avgWage = jobs ? round(sum(chosen.map((s) => s.item.jobs * s.item.wage)) / jobs) : 0;
    const perJob = jobs ? Math.round((spent * 1000) / jobs) : 0;
    const vsMarket = ctx.wageMarket > 0 ? Math.round((avgWage / ctx.wageMarket) * 100) : 100;

    const plan = chosen.length
      ? 'Програма з ' + chosen.length + ' ' +
        plural(chosen.length, 'напряму', 'напрямів', 'напрямів') + ': ' + jobs +
        ' робочих місць за ' + num(spent) + ' млн. Одне місце — ' + num(perJob) +
        ' тис. грн, середня зарплата ' + num(avgWage) + ' тис. (' + vsMarket +
        '% від середньої по району). Податки з цих зарплат повертають громаді ' +
        num(taxes) + ' млн на рік' +
        (payback > 0 ? ', тобто вкладення відіграються приблизно за ' + num(payback) + ' ' +
          plural(Math.round(payback), 'рік', 'роки', 'років') + '.' : '.')
      : 'Жоден напрям не вміщується в наявні гроші.';

    return {
      strategy,
      ranked,
      chosen,
      rejected,
      answer: chosen.map((s) => s.index).sort((a, b) => a - b).join(','),
      metrics: [
        { label: 'Робочих місць', value: jobs, unit: 'осіб', of: ctx.unemployed,
          note: chosen.length + ' ' + plural(chosen.length, 'напрям', 'напрями', 'напрямів') +
                ' за ' + num(spent) + ' млн' },
        { label: 'Середня зарплата', value: avgWage, unit: 'тис. грн',
          note: vsMarket + '% від середньої по району' },
        { label: 'Ціна одного місця', value: perJob, unit: 'тис. грн' },
        { label: 'Податки в бюджет', value: taxes, unit: 'млн/рік',
          note: payback > 0 ? 'вкладення відіграються за ' + num(payback) + ' р.' : '' },
      ],
      note: plan,
    };
  }

  const PLANNERS = { priority: planPriority, budget: planBudget, return: planReturn, jobs: planJobs };

  /* ── перевірка вхідних даних ────────────────────────────────────────── */

  function diagnose(scenario, items, ctx) {
    const out = [];
    const add = (level, text) => out.push({ level, text });

    if (items.length < 2) {
      add('error', 'Потрібно щонайменше два записи: модель порівнює їх між собою.');
      return out;
    }

    if (scenario.id === 'priority') {
      const need = sum(items.map((i) => i.cost));
      add('info', need > ctx.budget
        ? 'Усе разом коштує ' + round(need) + ' млн, а бюджет ' + ctx.budget +
          ' млн — вистачить приблизно на ' + Math.round((ctx.budget / need) * 100) + '% потреби.'
        : 'Бюджету вистачає на всі об\'єкти. Тут модель показує порядок робіт, а не вибір.');

      const many = items.filter((i) => i.served > ctx.population);
      if (many.length) {
        add('warn', 'У ' + many.length + ' об\'єкта(ів) користувачів більше, ніж мешканців громади. Перевірте числа.');
      }
    }

    if (scenario.id === 'budget') {
      const bad = items.filter((i) => i.state < 40);
      if (bad.length) {
        add('warn', 'У важкому стані: ' + bad.map((i) => i.name).join(', ') +
                    '. Пропорційний розподіл сам по собі їх не витягне.');
      }
      add('info', 'Гроші діляться пропорційно до балів, тож щось отримає кожна сфера — навіть та, де все відносно добре.');
    }

    if (scenario.id === 'jobs') {
      const need = sum(items.map((i) => i.cost));
      add('info', need > ctx.budget
        ? 'Усі напрями разом коштують ' + round(need) + ' млн, а є ' + ctx.budget +
          ' млн — вистачить приблизно на ' + Math.round((ctx.budget / need) * 100) + '% задуманого.'
        : 'Грошей вистачає на всі напрями. Тут модель показує порядок запуску, а не вибір.');

      const totalJobs = sum(items.map((i) => i.jobs));
      if (totalJobs > ctx.unemployed) {
        add('warn', 'Разом напрями дають ' + totalJobs + ' місць, а без роботи ' + ctx.unemployed +
                    ' осіб. Частину місць заповнити буде ніким — або їх заповнять приїжджі.');
      }

      /* Місце з платою помітно нижчою за ринкову стоїть порожнім, і тоді
         гроші витрачені, а роботи в громаді не з'явилось. Поріг у 80%
         узято як помітну різницю, а не як норму з якогось документа. */
      const poor = items.filter((i) => i.wage < ctx.wageMarket * 0.8);
      if (poor.length) {
        add('warn', 'Зарплата помітно нижча за середню по району: ' +
                    poor.map((i) => i.name + ' (' + i.wage + ' тис.)').join(', ') +
                    '. Такі місця важко заповнити, навіть коли вони створені.');
      }

      add('info', 'Чого модель не знає: чи є попит на продукт, чи знайдеться той, хто візьметься ' +
                  'за справу, і чи дадуть дозволи. Вона рахує лише місця, гроші й зарплату.');
    }

    if (scenario.id === 'return') {
      const overloaded = items.filter((i) => i.capacity <= ctx.current);
      if (overloaded.length) {
        add('error', 'Уже переповнені: ' + overloaded.map((i) => i.name).join(', ') +
                     '. Вільних місць там немає навіть для тих, хто живе зараз.');
      }
      if (ctx.current + ctx.wantReturn > Math.max(...items.map((i) => i.capacity))) {
        add('warn', 'Навіть найємніша ланка не витримає всіх, хто вже живе, плюс тих, хто хоче повернутися.');
      }

      /* Честно про те, чого важливості тут не роблять. Повзунки на третьому
         етапі рухаються, і людина має право думати, що від них залежить
         відповідь. У цій задачі — ні: межу задає кількість вільних місць і
         ціна розширення, а це фізика, не пріоритети. Промовчати означало б
         залишити на екрані ручку, яка нічого не крутить. */
      add('info', 'Важливості критеріїв у цій задачі не змінюють межу: скількох можна ' +
                  'прийняти, залежить від вільних місць і ціни розширення. Вони впливають ' +
                  'лише на бал ланок — на те, яку з них громада вважає головною. ' +
                  'Три варіанти тут різняться не розрахунком, а рішенням: ризикнути, ' +
                  'рухатися поступово чи спершу вкластися.');
    }

    return out;
  }

  /* ── головний вхід ──────────────────────────────────────────────────── */

  function analyze(scenario, items, ctx, weightOverride) {
    const t0 = performance.now();

    const variants = scenario.strategies.map((strategy) => {
      /* Якщо людина рухала повзунки важливості, її значення замінюють
         стратегічні: рахує машина, але пріоритети лишаються за людиною. */
      const strat = weightOverride ? { ...strategy, weights: weightOverride } : strategy;
      return PLANNERS[scenario.id](scenario, items, ctx, strat);
    });

    const diagnostics = diagnose(scenario, items, ctx);

    /* Чи є взагалі вибір.

       Інколи всі три варіанти дають той самий результат, і людина цього не
       розуміє: на екрані три картки, а відповідь одна. Причина завжди в
       числах, не в моделі. Або ресурсу з надлишком — тоді беруть усе й
       важливості ні на що не впливають. Або його катастрофічно мало —
       тоді набирають лише найдешевше, і знову незалежно від важливостей.

       Сказати про це мусить сам розрахунок. Модель, яка вдає вибір там,
       де вибору немає, тисне авторитетом — а це те, проти чого
       застосунок і зроблений. */
    const answers = variants.map((v) => v.answer).filter((x) => x !== null && x !== undefined);
    if (answers.length === variants.length && variants.length > 1
        && new Set(answers).size === 1) {
      diagnostics.push({
        level: 'info',
        text: 'Усі варіанти дали однаковий результат — за цих чисел важливості вже нічого ' +
              'не вирішують. Так буває, коли ресурсу або з надлишком, або надто мало. ' +
              'Щоб вибір став справжнім, змініть обсяг ресурсу або додайте записи, ' +
              'які конфліктують між критеріями: дороге й потрібне проти дешевого й ні.',
      });
    }

    return {
      scenarioId: scenario.id,
      variants,
      diagnostics,
      elapsedMs: round(performance.now() - t0),
      adjusted: Boolean(weightOverride),
    };
  }

  return { analyze, scoreItems, toScore, clamp, round, sum, plural };
})();
