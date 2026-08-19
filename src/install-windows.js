'use strict';
/*
 * Превращение системы в обычное приложение Windows.
 *
 * Что делает установка:
 *   1. Кладёт на Рабочий стол значок «Asher Diamonds» с фирменной иконкой.
 *   2. Прячет чёрное окно — система работает незаметно, как и положено
 *      программе. Останавливается значком «Asher — выключить».
 *   3. Открывает систему отдельным окном без адресной строки: выглядит
 *      как настоящее приложение, а не как страница в браузере.
 *   4. По желанию — запуск вместе с Windows, чтобы утром ничего не нажимать.
 *
 * Всё делается штатными средствами Windows, ничего доустанавливать не нужно.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'public', 'icons', 'asher.ico');
const PORT = Number(process.env.ASHER_PORT || 3000);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}
const hold = () => ask('\n  Нажмите Enter, чтобы закрыть окно... ');

// PowerShell есть в любой Windows — через него делаем ярлыки.
function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' });
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function makeShortcut({ file, target, args, icon, comment, workDir }) {
  powershell([
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + psQuote(file) + ');',
    '$s.TargetPath = ' + psQuote(target) + ';',
    args ? '$s.Arguments = ' + psQuote(args) + ';' : '',
    workDir ? '$s.WorkingDirectory = ' + psQuote(workDir) + ';' : '',
    icon ? '$s.IconLocation = ' + psQuote(icon) + ';' : '',
    comment ? '$s.Description = ' + psQuote(comment) + ';' : '',
    '$s.Save();',
  ].filter(Boolean).join(' '));
}

/*
 * Запуск без чёрного окна. Пакетный файл всегда показывает окно, поэтому
 * прячем его через wscript: он умеет запускать что угодно скрыто.
 */
function writeHiddenLauncher() {
  const vbs = path.join(ROOT, 'asher-скрытый-запуск.vbs');
  const body = [
    "' Запуск Asher без чёрного окна. Файл создан установкой, не редактируйте.",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = ' + JSON.stringify(ROOT).replace(/"/g, '"'),
    '\' 0 = окно скрыто, False = не ждать завершения',
    'sh.Run "cmd /c node server.js", 0, False',
  ].join('\r\n');
  fs.writeFileSync(vbs, body, 'latin1');
  return vbs;
}

/*
 * Открытие системы отдельным окном без адресной строки. Edge есть на любой
 * Windows, режим --app как раз для этого и сделан.
 */
function writeOpenLauncher() {
  const vbs = path.join(ROOT, 'asher-открыть.vbs');
  const body = [
    "' Открытие Asher отдельным окном. Файл создан установкой, не редактируйте.",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'root = ' + JSON.stringify(ROOT),
    'sh.CurrentDirectory = root',
    '',
    "' Порт берём из файла, который пишет сама система: если обычный был занят,",
    "' она работает на другом, и угаданный адрес привёл бы в пустоту.",
    'port = "' + PORT + '"',
    'portFile = root & "\\data\\asher-port.txt"',
    'If fso.FileExists(portFile) Then',
    '  Set f = fso.OpenTextFile(portFile, 1)',
    '  saved = Trim(f.ReadAll)',
    '  f.Close',
    '  If saved <> "" Then port = saved',
    'End If',
    'url = "http://localhost:" & port',
    '',
    "' Работает ли система. Если нет — поднимаем и ждём, пока ответит.",
    'alive = False',
    'On Error Resume Next',
    'Set http = CreateObject("MSXML2.XMLHTTP")',
    'http.open "GET", url & "/api/ping", False',
    'http.send',
    'If Err.Number = 0 Then alive = True',
    'Err.Clear',
    'On Error Goto 0',
    '',
    'If Not alive Then',
    '  sh.Run "cmd /c node server.js", 0, False',
    "  ' Ждём до 20 секунд: на медленном компьютере первый запуск не мгновенный",
    '  For i = 1 To 40',
    '    WScript.Sleep 500',
    '    On Error Resume Next',
    '    If fso.FileExists(portFile) Then',
    '      Set f = fso.OpenTextFile(portFile, 1)',
    '      saved = Trim(f.ReadAll)',
    '      f.Close',
    '      If saved <> "" Then url = "http://localhost:" & saved',
    '    End If',
    '    Set http = CreateObject("MSXML2.XMLHTTP")',
    '    http.open "GET", url & "/api/ping", False',
    '    http.send',
    '    If Err.Number = 0 Then',
    '      Err.Clear',
    '      On Error Goto 0',
    '      Exit For',
    '    End If',
    '    Err.Clear',
    '    On Error Goto 0',
    '  Next',
    'End If',
    '',
    "' Отдельное окно без адресной строки — выглядит как приложение",
    'edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe")',
    'If fso.FileExists(edge) Then',
    '  sh.Run """" & edge & """ --app=" & url, 1, False',
    'Else',
    '  sh.Run url, 1, False',
    'End If',
  ].join('\r\n');
  fs.writeFileSync(vbs, body, 'latin1');
  return vbs;
}

// Остановка: гасим только наш процесс, чужие программы на Node не трогаем.
function writeStopLauncher() {
  const vbs = path.join(ROOT, 'asher-выключить.vbs');
  const body = [
    "' Остановка Asher. Файл создан установкой, не редактируйте.",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""' +
      'Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
      'Where-Object { $_.CommandLine -like \'*server.js*\' } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }""", 0, True',
    'MsgBox "Asher остановлена.", 64, "Asher Diamonds"',
  ].join('\r\n');
  fs.writeFileSync(vbs, body, 'latin1');
  return vbs;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('\n  Эта установка предназначена для Windows.');
    console.log('  На Mac пользуйтесь файлом СТАРТ.command.\n');
    await hold();
    return;
  }

  console.log('');
  console.log('  Установка Asher Diamonds как приложения');
  console.log('  ---------------------------------------------------------');
  console.log('  На Рабочем столе появятся два значка:');
  console.log('    • Asher Diamonds  — открыть систему');
  console.log('    • Asher выключить — остановить работу');
  console.log('');
  console.log('  Чёрное окно больше показываться не будет.');
  console.log('  Ваши данные и файлы программы остаются на месте.');
  console.log('');

  const auto = (await ask('  Запускать вместе с Windows? (1 — да, Enter — нет): ')).trim();
  const autostart = ['1', 'y', 'да', 'д', 'lf'].includes(auto.toLowerCase());

  const openVbs = writeOpenLauncher();
  const stopVbs = writeStopLauncher();
  const hiddenVbs = writeHiddenLauncher();
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const desktop = path.join(os.homedir(), 'Desktop');

  makeShortcut({
    file: path.join(desktop, 'Asher Diamonds.lnk'),
    target: wscript, args: '"' + openVbs + '"',
    icon: ICON, workDir: ROOT, comment: 'Учётная система ювелирного магазина',
  });
  makeShortcut({
    file: path.join(desktop, 'Asher выключить.lnk'),
    target: wscript, args: '"' + stopVbs + '"',
    icon: ICON, workDir: ROOT, comment: 'Остановить Asher Diamonds',
  });
  console.log('\n  Значки на Рабочем столе созданы.');

  const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft',
    'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupLink = path.join(startup, 'Asher Diamonds.lnk');
  if (autostart) {
    fs.mkdirSync(startup, { recursive: true });
    makeShortcut({
      file: startupLink, target: wscript, args: '"' + hiddenVbs + '"',
      icon: ICON, workDir: ROOT, comment: 'Asher Diamonds — фоновый запуск',
    });
    console.log('  Автозапуск вместе с Windows включён.');
  } else if (fs.existsSync(startupLink)) {
    fs.rmSync(startupLink, { force: true });
    console.log('  Автозапуск выключен.');
  }

  console.log('');
  console.log('  Готово! Открываю систему...');
  spawn(wscript, [openVbs], { detached: true, stdio: 'ignore' }).unref();
  await hold();
}

main().catch(async e => {
  console.error('\n  Не получилось:', e && e.message ? e.message : e);
  console.error('  Систему по-прежнему можно запускать файлом СТАРТ.');
  await hold();
  process.exit(1);
});
