# Ежедневная резервная копия на компьютер магазина.
#
# Зачем. Система на сервере снимает копию раз в сутки, но кладёт её на тот же
# диск, где живёт база. От сбоя диска, пропавшего сервера и забытой оплаты
# хостинга такая копия не спасает вовсе — а именно так магазины и теряют учёт.
# Спасает копия в другом месте, и забирать её должен компьютер по расписанию,
# а не человек по памяти: люди забывают, и это свойство людей, а не их вина.
#
# Запуск без ключей — настройка: скрипт спросит адрес, папку и время, скачает
# пробную копию и заведёт ежедневную задачу Windows.
# Запуск с -Run — то самое ежедневное скачивание, его выполняет задача.
#
# Почему PowerShell, а не Node.js. После переезда на сервер система на этом
# компьютере больше не работает, и Node.js тут может не остаться вовсе.
# PowerShell есть в любой Windows.

param(
    [switch]$Run
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ПапкаНастроек = Join-Path $env:LOCALAPPDATA 'asher-копии'
$ФайлАдреса    = Join-Path $ПапкаНастроек 'адрес.txt'
$ФайлПапки     = Join-Path $ПапкаНастроек 'папка.txt'
$ИмяЗадачи     = 'Ежедневная копия учётной системы'
$СколькоХранить = 14

function Скачать {
    param([string]$Адрес, [string]$Куда)

    if (-not (Test-Path $Куда)) { New-Item -ItemType Directory -Path $Куда -Force | Out-Null }
    $имя = 'копия-' + (Get-Date -Format 'yyyy-MM-dd') + '.zip'
    $файл = Join-Path $Куда $имя
    $временный = $файл + '.часть'

    # Качаем во временный файл и переименовываем только после успеха. Иначе
    # оборванная посреди ночи закачка оставила бы битый архив с сегодняшней
    # датой — и владелец считал бы, что копия за этот день есть.
    Invoke-WebRequest -Uri $Адрес -OutFile $временный -UseBasicParsing -TimeoutSec 900

    # Проверяем, что это действительно архив, а не страница с ошибкой:
    # сервер на неверный ключ отвечает текстом, и без этой проверки текст
    # лёг бы на диск под именем копии.
    $первые = [System.IO.File]::ReadAllBytes($временный)[0..1]
    if ($первые[0] -ne 0x50 -or $первые[1] -ne 0x4B) {
        Remove-Item $временный -Force
        throw 'Сервер вернул не архив. Скорее всего, ключ отозван или изменён — выдайте новый в Настройках.'
    }

    Move-Item $временный $файл -Force

    # Оставляем последние копии, остальные убираем: иначе за год на диске
    # окажется 365 архивов с фотографиями, и место кончится молча.
    Get-ChildItem $Куда -Filter 'копия-*.zip' |
        Sort-Object Name -Descending |
        Select-Object -Skip $СколькоХранить |
        Remove-Item -Force

    return $файл
}

# ---------- Ежедневный запуск (его делает задача Windows) ----------

if ($Run) {
    if (-not (Test-Path $ФайлАдреса)) { exit 1 }
    $адрес = (Get-Content $ФайлАдреса -Raw).Trim()
    $папка = (Get-Content $ФайлПапки -Raw).Trim()
    try {
        $файл = Скачать -Адрес $адрес -Куда $папка
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm')  копия снята: $файл" |
            Add-Content (Join-Path $папка 'журнал.txt') -Encoding UTF8
    } catch {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm')  СБОЙ: $($_.Exception.Message)" |
            Add-Content (Join-Path $папка 'журнал.txt') -Encoding UTF8
        exit 1
    }
    exit 0
}

# ---------- Настройка (владелец запускает руками, один раз) ----------

Write-Host ''
Write-Host '  ЕЖЕДНЕВНАЯ КОПИЯ НА ЭТОТ КОМПЬЮТЕР' -ForegroundColor Cyan
Write-Host '  ----------------------------------------------------------'
Write-Host '  Раз в день компьютер сам заберёт с сервера копию всей базы'
Write-Host '  и фотографий. Настраивается один раз.'
Write-Host ''
Write-Host '  Адрес возьмите в системе: Настройки -> Безопасность ->'
Write-Host '  "Копия сама, каждый день" -> Выдать ключ. Там будет готовая'
Write-Host '  строка вида https://ваш-домен/api/backup/download?key=...'
Write-Host ''

$адрес = Read-Host '  Вставьте этот адрес и нажмите Enter'
$адрес = $адрес.Trim().Trim('"')
if ($адрес -notmatch '^https?://.+/api/backup/download\?key=.+') {
    Write-Host ''
    Write-Host '  Это не похоже на нужный адрес.' -ForegroundColor Red
    Write-Host '  Он должен заканчиваться на /api/backup/download?key=...'
    Write-Host '  Возьмите его в Настройках -> Безопасность и запустите файл снова.'
    Write-Host ''
    Read-Host '  Enter — закрыть'
    exit 1
}

$поумолчанию = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Копии учётной системы'
Write-Host ''
Write-Host "  Куда складывать копии. Enter — в папку по умолчанию:"
Write-Host "  $поумолчанию"
$папка = Read-Host '  Своя папка (или Enter)'
if ([string]::IsNullOrWhiteSpace($папка)) { $папка = $поумолчанию }

Write-Host ''
Write-Host '  Во сколько забирать копию? Лучше после закрытия магазина.'
$время = Read-Host '  Время в виде 21:00 (или Enter — 21:00)'
if ([string]::IsNullOrWhiteSpace($время)) { $время = '21:00' }
if ($время -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') {
    Write-Host ''
    Write-Host '  Время указано непонятно. Нужно вида 21:00.' -ForegroundColor Red
    Read-Host '  Enter — закрыть'
    exit 1
}

Write-Host ''
Write-Host '  Проверяю: скачиваю копию прямо сейчас...'
try {
    $файл = Скачать -Адрес $адрес -Куда $папка
    $размер = [math]::Round((Get-Item $файл).Length / 1MB, 1)
    Write-Host "  Готово: $файл ($размер МБ)" -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "  Не получилось: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Задачу не завожу — сначала надо, чтобы скачивание работало.'
    Write-Host ''
    Read-Host '  Enter — закрыть'
    exit 1
}

# Адрес содержит ключ, поэтому лежит в личной папке пользователя, а не рядом
# с копиями: папку с копиями кладут в облако и показывают другим.
if (-not (Test-Path $ПапкаНастроек)) { New-Item -ItemType Directory -Path $ПапкаНастроек -Force | Out-Null }
Set-Content $ФайлАдреса $адрес -Encoding UTF8
Set-Content $ФайлПапки  $папка -Encoding UTF8

$действие = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run' -f $PSCommandPath)
$триггер = New-ScheduledTaskTrigger -Daily -At $время
# StartWhenAvailable: если в назначенное время компьютер был выключен, задача
# выполнится при первом включении, а не пропустит день молча.
$условия = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

try {
    Register-ScheduledTask -TaskName $ИмяЗадачи -Action $действие -Trigger $триггер `
        -Settings $условия -Description 'Забирает с сервера копию базы и фотографий' -Force | Out-Null
} catch {
    Write-Host ''
    Write-Host "  Копия скачалась, но завести ежедневную задачу не вышло: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  Чаще всего помогает запуск от имени администратора:'
    Write-Host '  правой кнопкой по файлу -> «Запуск от имени администратора».'
    Write-Host ''
    Read-Host '  Enter — закрыть'
    exit 1
}

Write-Host ''
Write-Host '  ==========================================================' -ForegroundColor Green
Write-Host "   Настроено. Копия будет забираться каждый день в $время" -ForegroundColor Green
Write-Host '  =========================================================='
Write-Host ''
Write-Host "  Копии складываются в:  $папка"
Write-Host "  Хранятся последние $СколькоХранить, старые удаляются сами."
Write-Host "  Рядом лежит журнал.txt — там видно, снялась копия или был сбой."
Write-Host ''
Write-Host '  Раз в месяц копируйте свежий архив в облако или на флешку:'
Write-Host '  копия на том же компьютере не спасает от кражи и пожара.'
Write-Host ''
Write-Host "  Отключить: Планировщик заданий -> «$ИмяЗадачи» -> Удалить."
Write-Host ''
Read-Host '  Enter — закрыть'
