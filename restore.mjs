#!/usr/bin/env node
/**
 * Відновлює src/ із зашифрованої резервної копії src.enc.
 * Потрібен, якщо робочу папку втрачено, а в репозиторії лишився лише шифроблок.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

function askPassword(prompt) {
  if (process.env.BUILD_PASSWORD) return Promise.resolve(process.env.BUILD_PASSWORD);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(s.includes(prompt) ? s : '');
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const env = JSON.parse(await readFile(path.join(ROOT, 'src.enc'), 'utf8'));
  const password = await askPassword('Пароль: ');

  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(env.kdf.salt), iterations: env.kdf.iterations, hash: env.kdf.hash },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );

  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data),
    );
  } catch {
    // AES-GCM перевіряє цілісність, тож помилка тут означає або хибний пароль,
    // або пошкоджений файл — розрізнити їх криптографічно неможливо.
    throw new Error('Не вдалося розшифрувати: хибний пароль або пошкоджений src.enc');
  }

  const files = JSON.parse(new TextDecoder().decode(plain));
  await mkdir(path.join(ROOT, 'src'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(ROOT, 'src', name), content, 'utf8');
    console.log('  відновлено src/' + name);
  }
}

main().catch((err) => { console.error('Помилка:', err.message); process.exit(1); });
