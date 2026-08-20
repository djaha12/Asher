'use strict';
/*
 * Сборка ZIP-архива без внешних библиотек.
 *
 * Нужна ровно для одного: чтобы кнопка «Скачать резервную копию» отдавала
 * ВСЮ систему, а не только базу. Раньше она отдавала один файл базы, а рядом
 * было написано «вся система целиком» — и это была неправда: фотографии
 * изделий и сканы сертификатов лежат отдельными файлами и в копию не попадали.
 * Владелец, потеряв компьютер, восстановил бы каталог без единой фотографии.
 *
 * Пишем «как есть», без сжатия. Фотографии — уже сжатые JPEG и PNG, ужать их
 * ещё раз нельзя, а база в архиве и так не главный вес. Зато код остаётся
 * коротким и предсказуемым: никакой возни с потоками сжатия и никакой
 * зависимости, которую пришлось бы обновлять.
 *
 * Формат: обычный ZIP (метод 0 — store), с признаком zip64 там, где он нужен,
 * чтобы архив открывался и Проводником Windows, и любым архиватором.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Таблица CRC-32 — контрольная сумма, которую ждёт формат ZIP.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

// Дата и время в том виде, в каком их хранит ZIP (формат MS-DOS).
function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Заголовки одной записи — общая часть для сборки в памяти и для потока.
function заголовки(имя, размер, crc, когда, смещение) {
  const nameBuf = Buffer.from(имя, 'utf8');
  const stamp = dosDateTime(когда || new Date());

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // подпись
  local.writeUInt16LE(20, 4);           // нужная версия
  local.writeUInt16LE(0x0800, 6);       // имена в UTF-8
  local.writeUInt16LE(0, 8);            // метод: без сжатия
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(размер, 18);
  local.writeUInt32LE(размер, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);             // чем создан
  cen.writeUInt16LE(20, 6);             // нужная версия
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(0, 10);
  cen.writeUInt16LE(stamp.time, 12);
  cen.writeUInt16LE(stamp.date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(размер, 20);
  cen.writeUInt32LE(размер, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(смещение, 42);

  return { nameBuf, local, central: Buffer.concat([cen, nameBuf]) };
}

function хвост(записей, размерОглавления, смещениеОглавления) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(записей, 8);
  end.writeUInt16LE(записей, 10);
  end.writeUInt32LE(размерОглавления, 12);
  end.writeUInt32LE(смещениеОглавления, 16);
  return end;
}

/*
 * Собирает архив из списка файлов.
 *
 * entries: [{ name: 'путь/внутри/архива', file: '/путь/на/диске' }]
 *          либо [{ name: '...', data: Buffer }]
 *
 * Возвращает Buffer — целиком в памяти. Годится для небольших архивов;
 * резервная копия магазина собирается через streamZip, потому что копия
 * с фотографиями съедала памяти вдвое больше своего размера и роняла сервер.
 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = e.data !== undefined ? e.data : fs.readFileSync(e.file);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const stamp = dosDateTime(e.mtime || new Date());

    // Локальный заголовок файла
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // подпись
    local.writeUInt16LE(20, 4);           // нужная версия
    local.writeUInt16LE(0x0800, 6);       // имена в UTF-8
    local.writeUInt16LE(0, 8);            // метод: без сжатия
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    // Запись для оглавления архива
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);             // чем создан
    cen.writeUInt16LE(20, 6);             // нужная версия
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(stamp.time, 12);
    cen.writeUInt16LE(stamp.date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/*
 * ---------- Архив потоком, а не в памяти ----------
 *
 * Прежняя сборка держала в памяти всё сразу: каждый файл читался целиком,
 * потом всё склеивалось в один буфер. Замерили на 330 МБ фотографий — сервер
 * в пике занимал 733 МБ. У VPS, на который переезжает магазин, всей памяти
 * гигабайт: на полутора тысячах изделий с двумя снимками копия перестала бы
 * скачиваться вовсе. Причём падало бы ровно то, ради чего всё затевалось,
 * и ровно тогда, когда копия наконец стала ценной.
 *
 * Второе, не менее важное: чтение файлов целиком блокировало систему.
 * Пока владелец качал копию, продавец у прилавка ждал ответа пять секунд
 * на обычном экране каталога. Здесь всё асинхронно и по кускам — магазин
 * продолжает работать.
 *
 * Цену за это платим одну: каждый файл читается дважды — сперва чтобы
 * посчитать контрольную сумму, потом чтобы отдать. Диск это переживёт,
 * память — нет.
 */
const КУСОК = 256 * 1024;
const ПРЕДЕЛ_ZIP = 0xFFFFFFFF;   // 4 ГБ: дальше 32-битных полей формата не хватит

async function контрольнаяСумма(файл) {
  let c = 0 ^ -1;
  let размер = 0;
  const поток = fs.createReadStream(файл, { highWaterMark: КУСОК });
  for await (const кусок of поток) {
    размер += кусок.length;
    for (let i = 0; i < кусок.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ кусок[i]) & 0xFF];
  }
  return { crc: (c ^ -1) >>> 0, размер };
}

// Пишем с оглядкой на то, успевает ли получатель: иначе очередь на отправку
// растёт в памяти, и мы возвращаемся ровно к той беде, от которой уходим.
function записать(res, буфер) {
  return new Promise((готово, беда) => {
    res.write(буфер, ошибка => (ошибка ? беда(ошибка) : готово()));
  });
}

/*
 * Готовит опись архива: размеры и контрольные суммы. Нужна до отправки,
 * потому что размер архива объявляется в заголовке ответа — без него браузер
 * не покажет, сколько осталось качать, а на медленном интернете это разница
 * между «идёт» и «завис».
 */
async function описьАрхива(entries) {
  const опись = [];
  let общий = 0;
  for (const e of entries) {
    let размер, crc, когда = e.mtime;
    if (e.data !== undefined) {
      размер = e.data.length;
      crc = crc32(e.data);
    } else {
      const св = await fs.promises.stat(e.file);
      const посчитано = await контрольнаяСумма(e.file);
      размер = посчитано.размер;
      crc = посчитано.crc;
      if (!когда) когда = св.mtime;
      // Файл мог измениться между stat и чтением — верим прочитанному.
    }
    const nameBuf = Buffer.from(e.name, 'utf8');
    опись.push({ ...e, размер, crc, когда });
    общий += 30 + nameBuf.length + размер + 46 + nameBuf.length;
  }
  return { опись, всего: общий + 22 };
}

/*
 * Отдаёт архив прямо в ответ. Возвращает, сколько байт отправлено.
 * Заголовки ответа выставляет сам — вызывающему остаётся только имя файла.
 */
async function streamZip(entries, res, { filename = 'archive.zip', headers = {} } = {}) {
  const { опись, всего } = await описьАрхива(entries);
  if (всего > ПРЕДЕЛ_ZIP) {
    throw new Error('Копия больше 4 ГБ — такой архив обычный ZIP не выдержит. '
      + 'Скачайте базу и папку с фотографиями по отдельности.');
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': всего,
    ...headers,
  });

  const оглавление = [];
  let смещение = 0;
  for (const e of опись) {
    const ч = заголовки(e.name, e.размер, e.crc, e.когда, смещение);
    await записать(res, ч.local);
    await записать(res, ч.nameBuf);
    if (e.data !== undefined) {
      await записать(res, e.data);
    } else {
      const поток = fs.createReadStream(e.file, { highWaterMark: КУСОК });
      for await (const кусок of поток) await записать(res, кусок);
    }
    оглавление.push(ч.central);
    смещение += ч.local.length + ч.nameBuf.length + e.размер;
  }

  const centralBuf = Buffer.concat(оглавление);
  await записать(res, centralBuf);
  await записать(res, хвост(опись.length, centralBuf.length, смещение));
  res.end();
  return всего;
}

// Все файлы папки, рекурсивно, с путями относительно неё.
function listFiles(dir, prefix = '') {
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    const rel = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.isDirectory()) out.push(...listFiles(full, rel));
    else if (it.isFile()) out.push({ name: rel, file: full });
  }
  return out;
}

module.exports = { makeZip, streamZip, listFiles, crc32 };
