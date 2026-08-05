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
  console.log('   Наполнить  — введите цифру 1 и нажмите Enter');
  console.log('   Отменить   — просто нажмите Enter');
  console.log('  ---------------------------------------------------------');
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
    console.log('\n  Отменено — ничего не изменилось.');
    console.log('  Чтобы наполнить примерами, запустите файл снова');
    console.log('  и введите цифру 1.');
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
  } else {
    console.log('\n  Готово. Теперь запустите СТАРТ.');
  }
  await holdWindow();
}

main().catch(e => {
  console.error('\n  Ошибка:', e && e.message ? e.message : e);
  holdWindow().then(() => process.exit(1));
});
