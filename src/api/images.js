'use strict';
/*
 * Фотографии изделий.
 *
 * Файлы лежат в data/images/<id изделия>/<uuid>.<расширение> — папку целиком
 * можно скопировать для резервной копии. Уменьшенные копии (миниатюры) делает
 * браузер перед отправкой, поэтому серверу не нужны библиотеки обработки
 * изображений: он только проверяет и записывает то, что пришло.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, nowIso, audit, MEDIA_DIR } = require('../db');
const { ApiError } = require('./util');

const MAX_BYTES = 8 * 1024 * 1024;   // одно изображение — до 8 МБ
const MAX_PER_PRODUCT = 12;
// Отдельный лимит: сертификаты не должны съедать место, отведённое фотографиям.
const MAX_CERTS_PER_PRODUCT = 6;

// Определяем формат по сигнатуре файла, а не по заявленному типу:
// присланный MIME подделать легко, начало файла — нет.
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp', mime: 'image/webp',
    test: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

// Сертификат лаборатории чаще всего приходит с её сайта файлом PDF.
// Держим формат в ОТДЕЛЬНОМ списке: попади «%PDF-» в общий SIGNATURES —
// PDF начали бы принимать как фотографию изделия, и каталог с плитками сломался бы.
const PDF_SIGNATURE = {
  ext: 'pdf', mime: 'application/pdf',
  test: b => b.length > 4 && b.toString('ascii', 0, 5) === '%PDF-',
};
const CERT_SIGNATURES = [...SIGNATURES, PDF_SIGNATURE];

function detectFormat(buf) {
  return SIGNATURES.find(s => buf.length > 12 && s.test(buf)) || null;
}

function mimeForFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const sig = CERT_SIGNATURES.find(s => s.ext === ext);
  return sig ? sig.mime : 'application/octet-stream';
}

function decodeDataUrl(value, label) {
  if (typeof value !== 'string' || !value) throw new ApiError(400, `Не передано изображение (${label})`);
  const comma = value.indexOf(',');
  const base64 = comma > -1 && value.slice(0, comma).includes('base64') ? value.slice(comma + 1) : value;
  let buf;
  try { buf = Buffer.from(base64, 'base64'); }
  catch { throw new ApiError(400, 'Файл повреждён и не читается'); }
  if (!buf.length) throw new ApiError(400, 'Пустой файл');
  if (buf.length > MAX_BYTES) throw new ApiError(413, 'Фотография больше 8 МБ — уменьшите её');
  const fmt = detectFormat(buf);
  if (!fmt) throw new ApiError(400, 'Поддерживаются только JPG, PNG и WEBP');
  return { buf, fmt };
}

// То же самое для сертификата — но здесь дополнительно принимается PDF.
function decodeCertificate(value) {
  if (typeof value !== 'string' || !value) throw new ApiError(400, 'Не передан файл сертификата');
  const comma = value.indexOf(',');
  const base64 = comma > -1 && value.slice(0, comma).includes('base64') ? value.slice(comma + 1) : value;
  let buf;
  try { buf = Buffer.from(base64, 'base64'); }
  catch { throw new ApiError(400, 'Файл повреждён и не читается'); }
  if (!buf.length) throw new ApiError(400, 'Пустой файл');
  if (buf.length > MAX_BYTES) throw new ApiError(413, 'Файл сертификата больше 8 МБ');
  // Формат определяем по первым байтам, а не по заявленному типу.
  const fmt = CERT_SIGNATURES.find(s => s.test(buf));
  if (!fmt) throw new ApiError(400, 'Сертификат принимается в виде PDF, JPG, PNG или WEBP');
  return { buf, fmt };
}

function listCertificates(productId) {
  return db.prepare(
    `SELECT id, product_id, lab, number, file, thumb, mime, sort, created_at
       FROM product_certificates WHERE product_id = ? ORDER BY sort, id`
  ).all(productId);
}

function productDir(productId) {
  return path.join(MEDIA_DIR, String(productId));
}

// Отдаваемый путь всегда вида "<id>/<файл>" — проверяем, что в нём нет "..".
function safeMediaPath(rel) {
  const full = path.normalize(path.join(MEDIA_DIR, rel));
  if (full !== MEDIA_DIR && !full.startsWith(MEDIA_DIR + path.sep)) return null;
  return full;
}

function listImages(productId) {
  return db.prepare(
    'SELECT id, product_id, file, thumb, is_main, sort FROM product_images WHERE product_id = ? ORDER BY is_main DESC, sort, id'
  ).all(productId);
}

function removeFiles(rows) {
  for (const row of rows) {
    for (const rel of [row.file, row.thumb]) {
      if (!rel) continue;
      const full = safeMediaPath(rel);
      if (full) fs.rmSync(full, { force: true });
    }
  }
}

// Если главная фотография удалена — главной становится следующая по порядку.
function ensureMain(productId) {
  const has = db.prepare('SELECT 1 FROM product_images WHERE product_id = ? AND is_main = 1').get(productId);
  if (has) return;
  const first = db.prepare(
    'SELECT id FROM product_images WHERE product_id = ? ORDER BY sort, id LIMIT 1'
  ).get(productId);
  if (first) db.prepare('UPDATE product_images SET is_main = 1 WHERE id = ?').run(first.id);
}

function requireProduct(id) {
  const p = db.prepare('SELECT id, sku, name FROM products WHERE id = ?').get(id);
  if (!p) throw new ApiError(404, 'Изделие не найдено');
  return p;
}

const routes = [
  {
    method: 'GET', path: '/api/products/:id/images',
    handler: ({ params }) => ({ items: listImages(Number(params.id)) }),
  },

  {
    method: 'POST', path: '/api/products/:id/images',
    handler: ({ params, body, session }) => {
      const productId = Number(params.id);
      const product = requireProduct(productId);

      const count = db.prepare('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?').get(productId).c;
      if (count >= MAX_PER_PRODUCT) {
        throw new ApiError(400, `У изделия уже ${MAX_PER_PRODUCT} фотографий — удалите лишние`);
      }

      const full = decodeDataUrl(body.data, 'основное');
      // Миниатюра необязательна: если браузер её не прислал, показываем оригинал.
      const thumb = body.thumb ? decodeDataUrl(body.thumb, 'миниатюра') : full;

      const dir = productDir(productId);
      fs.mkdirSync(dir, { recursive: true });
      const base = crypto.randomUUID();
      const fileRel = path.posix.join(String(productId), `${base}.${full.fmt.ext}`);
      const thumbRel = path.posix.join(String(productId), `${base}_t.${thumb.fmt.ext}`);
      fs.writeFileSync(path.join(MEDIA_DIR, fileRel), full.buf);
      fs.writeFileSync(path.join(MEDIA_DIR, thumbRel), thumb.buf);

      const isMain = count === 0 ? 1 : (body.main ? 1 : 0);
      if (isMain) db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(productId);
      const maxSort = db.prepare(
        'SELECT COALESCE(MAX(sort), -1) AS s FROM product_images WHERE product_id = ?'
      ).get(productId).s;
      const info = db.prepare(
        'INSERT INTO product_images (product_id, file, thumb, is_main, sort, created_at) VALUES (?,?,?,?,?,?)'
      ).run(productId, fileRel, thumbRel, isMain, Number(maxSort) + 1, nowIso());

      audit(session.userId, 'upload_photo', 'product', productId, product.sku);
      return { id: Number(info.lastInsertRowid), file: fileRel, thumb: thumbRel, is_main: isMain };
    },
  },

  {
    method: 'POST', path: '/api/images/:id/main',
    handler: ({ params }) => {
      const id = Number(params.id);
      const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(id);
      if (!img) throw new ApiError(404, 'Фотография не найдена');
      db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(img.product_id);
      db.prepare('UPDATE product_images SET is_main = 1 WHERE id = ?').run(id);
      return { ok: true };
    },
  },

  {
    method: 'DELETE', path: '/api/images/:id',
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(id);
      if (!img) throw new ApiError(404, 'Фотография не найдена');
      db.prepare('DELETE FROM product_images WHERE id = ?').run(id);
      removeFiles([img]);
      ensureMain(img.product_id);
      audit(session.userId, 'delete_photo', 'product', img.product_id, '');
      return { ok: true };
    },
  },

  // ---------- Сертификаты на камни ----------

  {
    method: 'GET', path: '/api/products/:id/certificates',
    handler: ({ params }) => ({ items: listCertificates(Number(params.id)) }),
  },

  {
    method: 'POST', path: '/api/products/:id/certificates',
    handler: ({ params, body, session }) => {
      const productId = Number(params.id);
      const product = requireProduct(productId);
      const count = db.prepare(
        'SELECT COUNT(*) AS c FROM product_certificates WHERE product_id = ?'
      ).get(productId).c;
      if (count >= MAX_CERTS_PER_PRODUCT) {
        throw new ApiError(400, `У изделия уже ${MAX_CERTS_PER_PRODUCT} сертификатов`);
      }

      const file = decodeCertificate(body.data);
      // Миниатюра бывает только у картинки: PDF браузер отрисовать не может,
      // и в списке такой сертификат показывается значком документа.
      const thumb = body.thumb && file.fmt.ext !== 'pdf' ? decodeDataUrl(body.thumb, 'миниатюра') : null;

      const dir = productDir(productId);
      fs.mkdirSync(dir, { recursive: true });
      const base = crypto.randomUUID();
      const fileRel = path.posix.join(String(productId), `cert-${base}.${file.fmt.ext}`);
      fs.writeFileSync(path.join(MEDIA_DIR, fileRel), file.buf);
      let thumbRel = '';
      if (thumb) {
        thumbRel = path.posix.join(String(productId), `cert-${base}_t.${thumb.fmt.ext}`);
        fs.writeFileSync(path.join(MEDIA_DIR, thumbRel), thumb.buf);
      }

      const maxSort = db.prepare(
        'SELECT COALESCE(MAX(sort), -1) AS s FROM product_certificates WHERE product_id = ?'
      ).get(productId).s;
      const info = db.prepare(
        `INSERT INTO product_certificates (product_id, lab, number, file, thumb, mime, sort, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(productId,
        String(body.lab || '').trim().toUpperCase().slice(0, 20),
        String(body.number || '').trim().toUpperCase().slice(0, 40),
        fileRel, thumbRel, file.fmt.mime, Number(maxSort) + 1, nowIso());

      audit(session.userId, 'upload_certificate', 'product', productId, product.sku);
      return { id: Number(info.lastInsertRowid), file: fileRel, thumb: thumbRel, mime: file.fmt.mime };
    },
  },

  {
    // Удаляет только администратор: сертификат — документ, а не картинка.
    method: 'DELETE', path: '/api/certificates/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const cert = db.prepare('SELECT * FROM product_certificates WHERE id = ?').get(id);
      if (!cert) throw new ApiError(404, 'Сертификат не найден');
      db.prepare('DELETE FROM product_certificates WHERE id = ?').run(id);
      removeFiles([cert]);
      audit(session.userId, 'delete_certificate', 'product', cert.product_id, cert.number || '');
      return { ok: true };
    },
  },

  {
    // Массовая загрузка папки: браузер присылает имена файлов, сервер отвечает,
    // какому изделию какое имя соответствует. Так пользователь ещё до загрузки
    // видит, сколько фотографий найдёт своё изделие, а сколько — нет.
    method: 'POST', path: '/api/images/match',
    handler: ({ body }) => {
      const names = Array.isArray(body.names) ? body.names.slice(0, 20000) : [];
      if (!names.length) return { matched: {}, unmatched: [], already: {} };

      // Ключ ищем и по артикулу, и по штрихкоду — в выгрузках 1С встречается и то и другое.
      const index = new Map();
      const rows = db.prepare(`SELECT id, sku, barcode FROM products`).all();
      for (const r of rows) {
        const skuKey = String(r.sku || '').trim().toLowerCase();
        if (skuKey) index.set(skuKey, r.id);
        const bcKey = String(r.barcode || '').trim().toLowerCase();
        if (bcKey && !index.has(bcKey)) index.set(bcKey, r.id);
      }
      const counts = new Map();
      for (const r of db.prepare('SELECT product_id, COUNT(*) AS c FROM product_images GROUP BY product_id').all()) {
        counts.set(r.product_id, Number(r.c));
      }

      const matched = {};
      const unmatched = [];
      const already = {};
      for (const raw of names) {
        const name = String(raw || '');
        // "К-1234_2.jpg" → пробуем "к-1234_2", затем "к-1234": в выгрузках
        // второй и третий ракурс обычно помечают суффиксом через _ или -.
        const base = name.replace(/\.[^.]+$/, '').trim().toLowerCase();
        const candidates = [base, base.replace(/[_-]\d+$/, ''), base.replace(/\s*\(\d+\)$/, '')];
        const hit = candidates.map(c => index.get(c)).find(Boolean);
        if (hit) {
          matched[name] = hit;
          if (counts.get(hit)) already[name] = counts.get(hit);
        } else {
          unmatched.push(name);
        }
      }
      return { matched, unmatched, already };
    },
  },
];

module.exports = { routes, listImages, listCertificates, removeFiles, safeMediaPath, mimeForFile };
