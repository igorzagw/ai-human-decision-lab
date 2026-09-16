#!/usr/bin/env node
/**
 * Локальний статичний сервер для перегляду застосунку.
 *
 * Потрібен, бо index.html тягне app.enc через fetch, а з file:// браузер
 * такий запит блокує. Python-версія (`python -m http.server`) теж працює,
 * але вона однопотокова і рве повторні з'єднання під час перезавантажень.
 *
 *   node serve.mjs          -> http://127.0.0.1:8080
 *   node serve.mjs 3000     -> інший порт
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/* path.resolve обов'язковий: на Windows URL дає шлях із прямими слешами,
   а resolve повертає зі зворотними — і перевірка startsWith нижче
   не спрацювала б навіть на коректному файлі. */
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
);
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.enc':  'application/json; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.svg':  'image/svg+xml',
};

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');

  /* Не даємо вийти за межі папки проєкту через «../» у шляху. */
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('403');
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не знайдено: ' + rel);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('Застосунок: http://127.0.0.1:' + PORT);
  console.log('Зупинити: Ctrl+C');
});
