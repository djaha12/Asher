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

/*
 * Собирает архив из списка файлов.
 *
 * entries: [{ name: 'путь/внутри/архива', file: '/путь/на/диске' }]
 *          либо [{ name: '...', data: Buffer }]
 *
 * Возвращает Buffer. Для магазина этого достаточно: база — десятки мегабайт,
 * фотографии — считанные сотни. Если каталог однажды вырастет настолько, что
 * архив перестанет помещаться в память, здесь появится потоковая запись —
 * но усложнять раньше времени незачем.
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

module.exports = { makeZip, listFiles, crc32 };
