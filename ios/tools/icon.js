'use strict';
/*
 * Значок приложения для App Store: 1024×1024, без прозрачности.
 *
 * Значок сайта (public/icons/icon-512.png) для этого не годится по двум
 * причинам. Он скруглён и прозрачен по углам — а iOS скругляет значки сама,
 * и Apple отклоняет сборку, если в значке есть канал прозрачности. И он
 * вдвое меньше нужного.
 *
 * Рисуем тот же бриллиант заново, из той же линии, что в шапке системы,
 * и сохраняем пиксели без альфа-канала — своим кодировщиком PNG, чтобы
 * не тянуть в проект ни одной библиотеки.
 *
 * Запуск: node ios/tools/icon.js  → ios/Diamonds/Assets.xcassets/AppIcon.appiconset/icon-1024.png
 */
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { chromium } = require('../../тесты/браузер');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'Diamonds', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png');
const SIZE = 1024;

function png(width, height, rgb) {
  const строка = width * 3;
  const сырое = Buffer.alloc((строка + 1) * height);
  for (let y = 0; y < height; y++) {
    сырое[y * (строка + 1)] = 0;   // фильтр «нет» — сжатие сделает своё и так
    rgb.copy(сырое, y * (строка + 1) + 1, y * строка, (y + 1) * строка);
  }
  const блок = (тип, данные) => {
    const длина = Buffer.alloc(4); длина.writeUInt32BE(данные.length);
    const тд = Buffer.concat([Buffer.from(тип, 'ascii'), данные]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(тд) >>> 0);
    return Buffer.concat([длина, тд, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 2;    // RGB, без альфы — ради этого файл и пишется своим кодом
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    блок('IHDR', ihdr),
    блок('IDAT', zlib.deflateSync(сырое, { level: 9 })),
    блок('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const старый = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public', 'icons', 'icon-512.png')).toString('base64');
  const пиксели = await p.evaluate(async ({ старый, SIZE }) => {
    // Цвета берём из нынешнего значка, чтобы на телефоне он не «поменялся».
    const img = new Image();
    img.src = старый;
    await img.decode();
    const c0 = document.createElement('canvas'); c0.width = 512; c0.height = 512;
    const x0 = c0.getContext('2d'); x0.drawImage(img, 0, 0);
    const цвет = (x, y) => Array.from(x0.getImageData(x, y, 1, 1).data.slice(0, 3));
    const фон = цвет(256, 470);     // низ значка: фон под бриллиантом
    const золото = цвет(256, 220);  // средняя перекладина бриллианта

    const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    const x = c.getContext('2d');
    x.fillStyle = `rgb(${фон.join(',')})`;
    x.fillRect(0, 0, SIZE, SIZE);
    // Бриллиант из шапки системы: те же линии, та же толщина относительно размера.
    const k = SIZE / 24 * 0.56;
    const сдвиг = (SIZE - 24 * k) / 2;
    x.translate(сдвиг, сдвиг + k * 0.2);
    x.scale(k, k);
    x.strokeStyle = `rgb(${золото.join(',')})`;
    x.lineWidth = 1.25;
    x.lineJoin = 'round';
    x.lineCap = 'round';
    x.stroke(new Path2D('M7 3h10l4 6-9 12L3 9l4-6z'));
    x.stroke(new Path2D('M3 9h18M9.5 3 8 9l4 12M14.5 3 16 9l-4 12'));
    return { rgba: Array.from(x.getImageData(0, 0, SIZE, SIZE).data), фон, золото };
  }, { старый, SIZE });
  await b.close();

  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < пиксели.rgba.length; i += 4, j += 3) {
    rgb[j] = пиксели.rgba[i]; rgb[j + 1] = пиксели.rgba[i + 1]; rgb[j + 2] = пиксели.rgba[i + 2];
  }
  fs.writeFileSync(OUT, png(SIZE, SIZE, rgb));
  console.log(`значок: ${path.relative(ROOT, OUT)} · фон rgb(${пиксели.фон}) · золото rgb(${пиксели.золото})`);
})().catch(e => { console.error(e); process.exit(1); });
