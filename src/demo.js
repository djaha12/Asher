'use strict';
/*
 * Наполнение базы примерами — с предупреждением и подтверждением.
 *
 * Логика живёт здесь, а не в ярлыке ДЕМО-ДАННЫЕ.bat, по простой причине:
 * командное окно Windows ненадёжно исполняет пакетные файлы с русским
 * текстом — файл может молча оборваться на середине, и человек увидит просто
 * закрывшееся окно. Node.js работает с русским и с вводом без сюрпризов,
 * поэтому ярлык оставлен пустым и лишь вызывает этот файл.
 */
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

// Ждём Enter, чтобы окно не исчезло раньше, чем человек прочитает написанное.
async function holdWindow() {
  await ask('\n  Нажмите Enter, чтобы закрыть окно... ');
}

// Запуск системы в этом же окне: оно и становится «чёрным окном СТАРТ».
function startServer() {
  return new Promise(resolve => {
    const srv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ASHER_OPEN: '1' },
    });
    srv.on('close', resolve);
    srv.on('error', () => resolve(1));
  });
}

async function main() {
  console.log('');
  console.log('  Если у вас открыто чёрное окно СТАРТ — сначала закройте его!');
  console.log('');
  console.log('  Этот файл наполняет систему ПРИМЕРАМИ для знакомства:');
  console.log('  152 изделия, клиенты, продажи, долги, две точки продаж.');
  console.log('');
  console.log('  ВНИМАНИЕ: всё, что уже есть в системе, будет СТЁРТО.');
  console.log('  Не запускайте после того, как начали вести настоящий учёт!');
  console.log('');
  console.log('  ---------------------------------------------------------');
  console.log('   Наполнить примерами  — введите цифру 1 и нажмите Enter');
  console.log('   Не наполнять         — просто нажмите Enter');
  console.log('  ---------------------------------------------------------');
  console.log('  В обоих случаях система после этого запустится сама.');
  console.log('');

  /*
   * Просим ЦИФРУ 1, а не букву: единица набирается одной и той же клавишей
   * в любой раскладке. Буква Y на русской раскладке даёт «н», и человек,
   * ищущий её на клавиатуре, легко промахивается — так и вышло на практике.
   * Заодно принимаем всё, чем люди обычно отвечают «да», включая промахи
   * по раскладке.
   */
  const answer = (await ask('  Наполнить примерами? Введите цифру 1 и нажмите Enter: '))
    .trim().toLowerCase();
  const YES = [
    '1', 'y', 'yes', 'да', 'д', 'ok', 'ок',
    'н', 'ю', 'нуы',   // клавиши Y и yes, нажатые в русской раскладке
    'lf', 'lf,',       // «да», набранное в английской раскладке
  ];
  if (!YES.includes(answer)) {
    // Отказ — не тупик: запускаем систему с теми данными, что есть.
    console.log('\n  Хорошо, примеры не загружаю.');
    console.log('  Запускаю систему как есть — сейчас откроется браузер...');
    console.log('');
    await startServer();
    await holdWindow();
    return;
  }

  console.log('\n  Наполняю базу примерами, подождите...\n');
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join('src', 'seed.js'), '--reset'],
      { cwd: ROOT, stdio: 'inherit' });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });

  if (code !== 0) {
    console.log('\n  Не получилось наполнить базу.');
    console.log('  Проверьте, что чёрное окно СТАРТ закрыто, и запустите этот файл снова.');
    await holdWindow();
    return;
  }

  /*
   * Сразу запускаем систему, не заставляя человека искать второй файл.
   * Раньше здесь было «Теперь запустите СТАРТ» — и на этом месте люди
   * терялись: окно закрылось, ничего не открылось, выглядит как поломка.
   */
  console.log('\n  Готово! Запускаю систему — сейчас откроется браузер...');
  console.log('');
  await startServer();
  // Сюда попадаем, только когда сервер остановился.
  await holdWindow();
}

main().catch(e => {
  console.error('\n  Ошибка:', e && e.message ? e.message : e);
  holdWindow().then(() => process.exit(1));
});
