#!/usr/bin/env node
/**
 * Збірник застосунку «AI-Human Decision Lab».
 *
 * Що робить:
 *   1. Склеює src/ в один пакет {html, css, js}.
 *   2. Шифрує його паролем (PBKDF2-SHA256 -> AES-256-GCM) у app.enc.
 *   3. Шифрує самі вихідники у src.enc — резервна копія, бо /src/ не потрапляє в git.
 *
 * Пароль запитується інтерактивно і ніде не зберігається.
 * Для автоматизації: BUILD_PASSWORD=... node build.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(ROOT, 'src');

// Параметри KDF. 310 000 ітерацій — рекомендація OWASP для PBKDF2-SHA256.
// Число свідомо велике: воно робить перебір пароля дорогим саме для атакуючого,
// а легальному користувачеві коштує ~0,3 с один раз за сеанс.
export const KDF_ITERATIONS = 310_000;

const SRC_FILES = [
  'app.html',
  'app.css',
  'scenarios.js',
  'engine.js',
  'llm.js',
  'ui.js',
];

const b64 = (buf) => Buffer.from(buf).toString('base64');

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
  );
  return JSON.stringify({
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: b64(salt) },
    cipher: 'AES-GCM',
    iv: b64(iv),
    data: b64(data),
  });
}

function askPassword(prompt) {
  if (process.env.BUILD_PASSWORD) return Promise.resolve(process.env.BUILD_PASSWORD);
  if (!process.stdin.isTTY) {
    throw new Error(
      'Немає інтерактивного терміналу. Запусти "node build.mjs" у своєму терміналі\n' +
      'або передай пароль через змінну: BUILD_PASSWORD=... node build.mjs',
    );
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Глушимо ехо, щоб пароль не лишився у скролі терміналу.
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(s.includes(prompt) ? s : '');
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const sources = {};
  for (const name of SRC_FILES) {
    sources[name] = await readFile(path.join(SRC, name), 'utf8');
  }

  const bundle = {
    builtAt: new Date().toISOString(),
    html: sources['app.html'],
    css: sources['app.css'],
    js: ['scenarios.js', 'engine.js', 'llm.js', 'ui.js'].map((f) => sources[f]).join('\n;\n'),
  };

  const password = await askPassword('Пароль для застосунку: ');
  if (password.length < 8) throw new Error('Пароль закороткий — мінімум 8 символів.');

  await writeFile(path.join(ROOT, 'app.enc'), await encrypt(JSON.stringify(bundle), password));
  await writeFile(path.join(ROOT, 'src.enc'), await encrypt(JSON.stringify(sources), password));

  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' КБ';
  console.log('Зібрано:');
  console.log('  app.enc  — застосунок          ', kb(await readFile(path.join(ROOT, 'app.enc'), 'utf8')));
  console.log('  src.enc  — копія вихідників    ', kb(await readFile(path.join(ROOT, 'src.enc'), 'utf8')));
}

main().catch((err) => { console.error('Помилка:', err.message); process.exit(1); });
