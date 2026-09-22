// Робот для App Store Connect — без библиотек, только Node.
//
// Всё, что обычно делают руками в Xcode и на сайте App Store Connect, здесь
// делается через их API с ключом владельца (секреты ASC_ISSUER_ID, ASC_KEY_ID,
// ASC_KEY_P8):
//
//   check             — ключ работает? есть ли приложение в App Store Connect?
//   prepare-signing   — идентификатор приложения, уведомления, сертификат и профиль
//                       для подписи — одноразовые, на одну сборку;
//   cleanup-signing   — отозвать одноразовый сертификат и удалить профиль;
//   wait-build        — дождаться, пока Apple обработает загруженную сборку;
//   submit            — описание, скриншоты, данные для проверяющего, сборка,
//                       отправка на проверку.
//
// Почему сертификат одноразовый. Подписать сборку можно только сертификатом,
// закрытый ключ которого лежит там, где идёт сборка. Постоянного Mac у магазина
// нет, а хранить ключ в открытом хранилище нельзя. Поэтому каждая сборка
// заводит себе свежий сертификат и в конце его отзывает. Приложений, уже
// принятых в App Store, отзыв не касается: Apple переподписывает их своим.
// Сертификаты, которые завёл не робот, робот не трогает никогда: узнаёт свои
// по профилю с именем «Diamonds robot …».

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_ID = process.env.ASC_BUNDLE_ID || 'kg.diamonds.crm';
// Адрес API и паузы подменяются только в проверках (тесты/appstore-test.js).
const API = process.env.ASC_API || 'https://api.appstoreconnect.apple.com';
const ПАУЗА_ОБРАБОТКИ = Number(process.env.ASC_POLL_MS || 30000);
const РОБОТ = 'Diamonds robot';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const APPSTORE = path.join(HERE, '..', 'appstore');

// ---------- Ключ и пропуск ----------

/*
 * Файл .p8 вставляют в секрет по-разному: с переносами строк, без них,
 * с лишними пробелами. Собираем PEM заново из того, что между рамками.
 */
function pemИз(сырой) {
  const тело = String(сырой || '').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!тело) return '';
  return `-----BEGIN PRIVATE KEY-----\n${тело.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function ключ() {
  if (!String(process.env.ASC_KEY_P8 || '').trim() || !process.env.ASC_KEY_ID || !process.env.ASC_ISSUER_ID) {
    throw new Error('Нет ключа App Store Connect: нужны секреты ASC_ISSUER_ID, ASC_KEY_ID и ASC_KEY_P8.');
  }
  return crypto.createPrivateKey(pemИз(process.env.ASC_KEY_P8));
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let пропуск = null;
function выписать() {
  const сейчас = Math.floor(Date.now() / 1000);
  if (пропуск && сейчас - пропуск.iat < 15 * 60) return пропуск.token;
  const голова = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
  const тело = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: сейчас, exp: сейчас + 19 * 60, aud: 'appstoreconnect-v1' }));
  const подпись = crypto.sign('sha256', Buffer.from(`${голова}.${тело}`), { key: ключ(), dsaEncoding: 'ieee-p1363' });
  пропуск = { token: `${голова}.${тело}.${b64url(подпись)}`, iat: сейчас };
  return пропуск.token;
}

function объяснить(json) {
  return ((json && json.errors) || []).map(e => [e.title, e.detail, e.source && e.source.pointer].filter(Boolean).join(': ')).join('; ');
}

async function api(метод, адрес, тело, { можно404 = false } = {}) {
  for (let попытка = 1; ; попытка++) {
    const r = await fetch(API + адрес, {
      method: метод,
      headers: { Authorization: 'Bearer ' + выписать(), 'Content-Type': 'application/json' },
      body: тело === undefined ? undefined : JSON.stringify(тело),
    });
    const текст = await r.text();
    let json = null;
    try { json = текст ? JSON.parse(текст) : null; } catch { /* не JSON */ }
    if (r.ok) return json;
    if (можно404 && r.status === 404) return null;
    // Apple иногда отвечает «слишком часто» или падает на секунду — повторяем.
    if ((r.status === 429 || r.status >= 500) && попытка < 5) { await пауза(3000 * попытка); continue; }
    const e = new Error(`${метод} ${адрес} → ${r.status}: ${объяснить(json) || текст.slice(0, 400)}`);
    e.status = r.status;
    e.json = json;
    throw e;
  }
}

const пауза = мс => new Promise(r => setTimeout(r, мс));

function вывод(имя, значение) {
  console.log(`${имя}=${значение}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${имя}=${значение}\n`);
}

function аргумент(имя, умолч) {
  const i = process.argv.indexOf('--' + имя);
  return i > 0 ? process.argv[i + 1] : умолч;
}

// ---------- Приложение и идентификатор ----------

async function найтиИдентификатор() {
  const r = await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=50`);
  return (r.data || []).find(b => b.attributes.identifier === BUNDLE_ID) || null;
}

async function найтиПриложение() {
  const r = await api('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=5`);
  return (r.data || []).find(a => a.attributes.bundleId === BUNDLE_ID) || null;
}

/*
 * Идентификатор приложения kg.diamonds.crm с включёнными уведомлениями.
 * Заводит, если его ещё нет: без него на сайте App Store Connect нельзя даже
 * создать карточку приложения — в списке выбора будет пусто. Уведомления
 * включаются до создания профиля подписи: профиль запоминает возможности
 * приложения в момент создания.
 */
async function идентификатор() {
  let иден = await найтиИдентификатор();
  if (!иден) {
    иден = (await api('POST', '/v1/bundleIds', {
      data: { type: 'bundleIds', attributes: { identifier: BUNDLE_ID, name: 'Diamonds', platform: 'IOS' } },
    })).data;
    console.log(`заведён идентификатор ${BUNDLE_ID}`);
  }
  const возможности = await api('GET', `/v1/bundleIds/${иден.id}/bundleIdCapabilities`);
  if (!(возможности.data || []).some(c => c.attributes.capabilityType === 'PUSH_NOTIFICATIONS')) {
    await api('POST', '/v1/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'PUSH_NOTIFICATIONS' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: иден.id } } },
      },
    });
    console.log('уведомления для приложения включены');
  }
  return иден;
}

async function check() {
  const иден = await идентификатор();
  console.log('ключ App Store Connect работает: да');
  console.log(`идентификатор ${BUNDLE_ID}: есть, уведомления включены (команда ${иден.attributes.seedId})`);
  const прил = await найтиПриложение();
  console.log(`карточка приложения в App Store Connect: ${прил ? '«' + прил.attributes.name + '»' : 'НЕТ — её нужно создать на сайте (см. инструкцию)'}`);
  вывод('app_exists', прил ? '1' : '0');
  вывод('team_id', иден.attributes.seedId);
  if (!прил && process.argv.includes('--need-app')) {
    throw new Error(`Карточки приложения в App Store Connect ещё нет — загружать сборку некуда. ` +
      `Создайте её: appstoreconnect.apple.com → Приложения → «+» → Новое приложение, ` +
      `идентификатор пакета — ${BUNDLE_ID} (робот его уже завёл). Потом запустите робота снова.`);
  }
}

/*
 * Ключ из секрета — в файл, пригодный для Apple и для сервера.
 *   node ios/tools/appstore.mjs pem --env APNS_KEY_P8 --out /путь/apns.p8
 * Ключ проверяется тут же: испорченный при копировании секрет лучше
 * поймать здесь, чем разбираться потом, почему молчат уведомления.
 */
async function pem() {
  const имя = аргумент('env');
  const текстКлюча = pemИз(process.env[имя]);
  if (!текстКлюча) throw new Error(`Секрет ${имя} пуст.`);
  try { crypto.createPrivateKey(текстКлюча); } catch (e) {
    throw new Error(`Секрет ${имя} не похож на ключ Apple (.p8): ${e.message}. Вставьте содержимое файла .p8 целиком.`);
  }
  fs.writeFileSync(аргумент('out'), текстКлюча, { mode: 0o600 });
  console.log(`ключ из ${имя} записан`);
}

/*
 * Номер команды разработчика — нужен серверу для уведомлений. Это та же
 * приставка, что у идентификатора приложения (у всех учётных записей,
 * заведённых после 2011 года, они совпадают).
 */
async function team() {
  const иден = await идентификатор();
  вывод('team_id', иден.attributes.seedId);
}

// ---------- Подпись ----------

async function prepareSigning() {
  const csr = fs.readFileSync(аргумент('csr'), 'utf8');
  const куда = аргумент('out');
  const прогон = аргумент('run', String(Date.now()));
  fs.mkdirSync(куда, { recursive: true });

  const иден = await идентификатор();
  const команда = иден.attributes.seedId;

  // Прибираем за прошлыми сборками, если какая-то упала, не успев убрать своё.
  const профили = await api('GET', `/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  for (const п of (профили.data || []).filter(p => p.attributes.name.startsWith(РОБОТ))) {
    const серты = await api('GET', `/v1/profiles/${п.id}/certificates`, undefined, { можно404: true });
    for (const с of (серты && серты.data) || []) {
      await api('DELETE', `/v1/certificates/${с.id}`, undefined, { можно404: true });
      console.log(`отозван оставшийся сертификат робота ${с.id}`);
    }
    await api('DELETE', `/v1/profiles/${п.id}`, undefined, { можно404: true });
  }

  const csrТело = csr.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, '');
  let серт;
  try {
    серт = (await api('POST', '/v1/certificates', {
      data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csrТело } },
    })).data;
  } catch (e) {
    if (e.status === 409) {
      throw new Error('Apple не даёт завести ещё один сертификат распространения — достигнут предел. ' +
        'Удалите ненужный: developer.apple.com → Certificates, IDs & Profiles → Certificates. ' + e.message);
    }
    throw e;
  }
  fs.writeFileSync(path.join(куда, 'distribution.cer'), Buffer.from(серт.attributes.certificateContent, 'base64'));
  // Номер сертификата записываем сразу: если дальше что-то упадёт, уборка
  // в конце сборки всё равно найдёт его и отзовёт.
  fs.writeFileSync(path.join(куда, 'signing.json'), JSON.stringify({ certId: серт.id }));

  const имяПрофиля = `${РОБОТ} ${прогон}`;
  const профиль = (await api('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: имяПрофиля, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: иден.id } },
        certificates: { data: [{ type: 'certificates', id: серт.id }] },
      },
    },
  })).data;
  fs.writeFileSync(path.join(куда, 'profile.mobileprovision'), Buffer.from(профиль.attributes.profileContent, 'base64'));
  fs.writeFileSync(path.join(куда, 'signing.json'), JSON.stringify({ certId: серт.id, profileId: профиль.id }));

  вывод('team_id', команда);
  вывод('profile_name', имяПрофиля);
  вывод('profile_uuid', профиль.attributes.uuid);
}

async function cleanupSigning() {
  const файл = path.join(аргумент('out'), 'signing.json');
  if (!fs.existsSync(файл)) return;
  const { certId, profileId } = JSON.parse(fs.readFileSync(файл, 'utf8'));
  if (profileId) await api('DELETE', `/v1/profiles/${profileId}`, undefined, { можно404: true });
  if (certId) await api('DELETE', `/v1/certificates/${certId}`, undefined, { можно404: true });
  console.log('одноразовый сертификат отозван, профиль удалён');
}

// ---------- Сборка ----------

async function приложениеИлиОшибка() {
  const прил = await найтиПриложение();
  if (!прил) {
    throw new Error(`В App Store Connect нет приложения с идентификатором ${BUNDLE_ID}. ` +
      'Создайте его: appstoreconnect.apple.com → Приложения → «+» → Новое приложение (см. инструкцию).');
  }
  return прил;
}

async function найтиСборку(прил, номер) {
  const r = await api('GET', `/v1/builds?filter[app]=${прил.id}&filter[version]=${encodeURIComponent(номер)}&limit=5`);
  return (r.data || [])[0] || null;
}

async function waitBuild() {
  const прил = await приложениеИлиОшибка();
  const номер = аргумент('build');
  // Обработка сборки у Apple — обычно 5–20 минут.
  for (let i = 0; i < 90; i++) {
    const сборка = await найтиСборку(прил, номер);
    const состояние = сборка && сборка.attributes.processingState;
    console.log(`сборка ${номер}: ${состояние || 'ещё не видна'}`);
    if (состояние === 'VALID') { вывод('build_id', сборка.id); return; }
    if (состояние === 'FAILED' || состояние === 'INVALID') {
      throw new Error(`Apple не принял сборку ${номер}: ${состояние}. Подробности придут письмом на почту аккаунта.`);
    }
    await пауза(ПАУЗА_ОБРАБОТКИ);
  }
  throw new Error('Apple обрабатывает сборку дольше 45 минут — запустите отправку позже.');
}

// ---------- Отправка на проверку ----------

const текст = имя => fs.readFileSync(path.join(APPSTORE, имя), 'utf8').trim();

const ПРАВИМЫЕ = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);

async function версияДляПравки(прил, строкаВерсии) {
  const r = await api('GET', `/v1/apps/${прил.id}/appStoreVersions?filter[platform]=IOS&limit=20`);
  const есть = (r.data || []).find(v => ПРАВИМЫЕ.has(v.attributes.appStoreState) || ПРАВИМЫЕ.has(v.attributes.appVersionState));
  if (есть) return есть;
  return (await api('POST', '/v1/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: строкаВерсии },
      relationships: { app: { data: { type: 'apps', id: прил.id } } },
    },
  })).data;
}

async function описание(версия) {
  const r = await api('GET', `/v1/appStoreVersions/${версия.id}/appStoreVersionLocalizations`);
  let лок = (r.data || []).find(l => l.attributes.locale === 'ru') || (r.data || [])[0];
  const поля = {
    description: текст('ru/description.txt'),
    keywords: текст('ru/keywords.txt'),
    promotionalText: текст('ru/promotional_text.txt'),
    supportUrl: текст('support_url.txt'),
    marketingUrl: текст('marketing_url.txt'),
  };
  const записать = async () => {
    if (!лок) {
      лок = (await api('POST', '/v1/appStoreVersionLocalizations', {
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: { locale: 'ru', ...поля },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: версия.id } } },
        },
      })).data;
    } else {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${лок.id}`, {
        data: { type: 'appStoreVersionLocalizations', id: лок.id, attributes: поля },
      });
    }
  };
  try {
    await записать();
  } catch (e) {
    /*
     * Ключевые слова ограничены сотней — но где-то Apple считает не буквы,
     * а байты, и русская буква тогда весит две. Если не влезло — убираем
     * слова с конца списка, пока не влезет, и пробуем ещё раз.
     */
    if (!/keywords/i.test(e.message)) throw e;
    const слова = поля.keywords.split(',');
    while (слова.length > 1 && Buffer.byteLength(слова.join(','), 'utf8') > 100) слова.pop();
    поля.keywords = слова.join(',');
    console.log(`ключевые слова сокращены до «${поля.keywords}»`);
    await записать();
  }
  console.log(`описание (${лок.attributes.locale}) заполнено`);
  return лок;
}

async function сведенияОПриложении(прил) {
  const r = await api('GET', `/v1/apps/${прил.id}/appInfos`);
  const инфо = (r.data || []).find(i => i.attributes.appStoreState !== 'READY_FOR_SALE' && i.attributes.state !== 'READY_FOR_DISTRIBUTION')
    || (r.data || [])[0];
  await api('PATCH', `/v1/appInfos/${инфо.id}`, {
    data: {
      type: 'appInfos', id: инфо.id,
      relationships: {
        primaryCategory: { data: { type: 'appCategories', id: 'BUSINESS' } },
        secondaryCategory: { data: { type: 'appCategories', id: 'PRODUCTIVITY' } },
      },
    },
  });
  const л = await api('GET', `/v1/appInfos/${инфо.id}/appInfoLocalizations`);
  for (const лок of л.data || []) {
    await api('PATCH', `/v1/appInfoLocalizations/${лок.id}`, {
      data: {
        type: 'appInfoLocalizations', id: лок.id,
        attributes: { subtitle: текст('ru/subtitle.txt'), privacyPolicyUrl: текст('privacy_url.txt') },
      },
    });
  }
  console.log('категория «Бизнес», подзаголовок и адрес политики заполнены');

  /*
   * Возрастной рейтинг: в системе нет ничего из того, о чём спрашивает Apple, —
   * ни насилия, ни азартных игр, ни чатов, ни рекламы. Имена вопросов Apple
   * время от времени меняет, поэтому отвечаем на те, что пришли в ответе:
   * вопросы-перечисления — «нет», вопросы да/нет — «нет».
   */
  const рейтинг = await api('GET', `/v1/appInfos/${инфо.id}/ageRatingDeclaration`, undefined, { можно404: true });
  if (рейтинг && рейтинг.data) {
    const ПЕРЕЧИСЛЕНИЯ = new Set(['alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated',
      'horrorOrFearThemes', 'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation',
      'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity', 'sexualContentOrNudity',
      'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic',
      'gunsOrOtherWeapons']);
    const ОТДЕЛЬНЫЕ = new Set(['kidsAgeBand', 'ageRatingOverride', 'ageRatingOverrideV2', 'koreaAgeRatingOverride']);
    const ответы = {};
    for (const [имя, было] of Object.entries(рейтинг.data.attributes || {})) {
      if (ОТДЕЛЬНЫЕ.has(имя)) continue;
      if (ПЕРЕЧИСЛЕНИЯ.has(имя) || typeof было === 'string') ответы[имя] = 'NONE';
      else ответы[имя] = false;
    }
    try {
      await api('PATCH', `/v1/ageRatingDeclarations/${рейтинг.data.id}`, {
        data: { type: 'ageRatingDeclarations', id: рейтинг.data.id, attributes: ответы },
      });
      console.log('возрастной рейтинг: 4+ (ничего из списка Apple в системе нет)');
    } catch (e) {
      console.log('ВНИМАНИЕ: возрастной рейтинг не заполнился сам — заполните на сайте (все ответы «нет»): ' + e.message);
    }
  }

  await api('PATCH', `/v1/apps/${прил.id}`, {
    data: { type: 'apps', id: прил.id, attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } },
  }).catch(e => console.log('ВНИМАНИЕ: права на контент не отметились: ' + e.message));
}

async function данныеДляПроверяющего(версия) {
  const [имя, фамилия, телефон, почта] = String(process.env.REVIEW_CONTACT || '').split(';').map(s => s.trim());
  if (!имя || !фамилия || !телефон || !почта) {
    throw new Error('Нет контакта для проверяющего Apple: секрет REVIEW_CONTACT в виде «Имя;Фамилия;+996…;почта».');
  }
  const атрибуты = {
    contactFirstName: имя, contactLastName: фамилия, contactPhone: телефон, contactEmail: почта,
    demoAccountName: 'admin', demoAccountPassword: 'admin123', demoAccountRequired: true,
    notes: текст('review_notes.txt'),
  };
  const есть = await api('GET', `/v1/appStoreVersions/${версия.id}/appStoreReviewDetail`, undefined, { можно404: true });
  if (есть && есть.data) {
    await api('PATCH', `/v1/appStoreReviewDetails/${есть.data.id}`, {
      data: { type: 'appStoreReviewDetails', id: есть.data.id, attributes: атрибуты },
    });
  } else {
    await api('POST', '/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails', attributes: атрибуты,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: версия.id } } },
      },
    });
  }
  console.log('данные для проверяющего и демо-вход заполнены');
}

async function скриншоты(лок) {
  const папка = path.join(APPSTORE, 'screenshots');
  const файлы = fs.readdirSync(папка).filter(f => f.endsWith('.png')).sort();
  const наборы = await api('GET', `/v1/appStoreVersionLocalizations/${лок.id}/appScreenshotSets`);
  let набор = (наборы.data || []).find(s => s.attributes.screenshotDisplayType === 'APP_IPHONE_67');
  if (!набор) {
    набор = (await api('POST', '/v1/appScreenshotSets', {
      data: {
        type: 'appScreenshotSets', attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
        relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: лок.id } } },
      },
    })).data;
  }
  // Повторная отправка заменяет скриншоты, а не добавляет к старым.
  const старые = await api('GET', `/v1/appScreenshotSets/${набор.id}/appScreenshots`);
  for (const с of старые.data || []) await api('DELETE', `/v1/appScreenshots/${с.id}`, undefined, { можно404: true });

  for (const имя of файлы) {
    const данные = fs.readFileSync(path.join(папка, имя));
    const снимок = (await api('POST', '/v1/appScreenshots', {
      data: {
        type: 'appScreenshots', attributes: { fileName: имя, fileSize: данные.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: набор.id } } },
      },
    })).data;
    for (const оп of снимок.attributes.uploadOperations || []) {
      const заголовки = Object.fromEntries((оп.requestHeaders || []).map(h => [h.name, h.value]));
      const r = await fetch(оп.url, { method: оп.method, headers: заголовки, body: данные.subarray(оп.offset, оп.offset + оп.length) });
      if (!r.ok) throw new Error(`Скриншот ${имя} не загрузился: ${r.status}`);
    }
    await api('PATCH', `/v1/appScreenshots/${снимок.id}`, {
      data: {
        type: 'appScreenshots', id: снимок.id,
        attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(данные).digest('hex') },
      },
    });
    console.log(`скриншот ${имя} загружен`);
  }
}

/*
 * Всё, куда пойдёт проверяющий, должно открываться ДО отправки. Иначе отказ
 * придёт через день-два, с формулировкой «не смогли войти» — и очередь
 * на проверку начнётся заново.
 */
async function готовностьСайта() {
  const сайт = new URL(текст('marketing_url.txt'));
  const демо = process.env.ASC_DEMO_BASE || `https://demo.${сайт.host}`;
  const куда = адрес => process.env.ASC_SITE_BASE ? new URL(new URL(адрес).pathname, process.env.ASC_SITE_BASE).href : адрес;
  const проблемы = [];
  for (const адрес of [текст('privacy_url.txt'), текст('support_url.txt')].map(куда)) {
    const r = await fetch(адрес).catch(e => ({ ok: false, status: e.message }));
    if (!r.ok) { проблемы.push(`${адрес} не открывается (${r.status})`); continue; }
    // На странице поддержки Apple ищет, как связаться с разработчиком (правило 1.5).
    if (адрес === куда(текст('support_url.txt')) && !/href="(tel|mailto):/.test(await r.text())) {
      проблемы.push(`на странице поддержки ${адрес} нет ни телефона, ни почты — заполните их в системе: Настройки → Магазин`);
    }
  }
  try {
    const r = await fetch(демо + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Asher-Device': 'app-store-robot-' + Date.now() },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    if (!r.ok) проблемы.push(`в демо-версии ${демо} не входит admin / admin123 (ответ ${r.status})`);
  } catch (e) {
    проблемы.push(`демо-версия ${демо} не открывается (${e.cause ? e.cause.code || e.cause.message : e.message})`);
  }
  if (проблемы.length) {
    throw new Error('Проверяющий Apple упрётся в это, поэтому отправка остановлена:\n  - ' + проблемы.join('\n  - ') +
      '\nЧто сделать: запись demo у регистратора домена и робот «Сервер для приложения» (см. инструкцию).');
  }
  console.log(`сайт готов: политика и поддержка открываются, в демо-версии ${демо} вход admin / admin123 работает`);
}

async function submit() {
  const пробно = аргумент('dry', '') === '1';
  try {
    await готовностьСайта();
  } catch (e) {
    // Пробный прогон только заполняет карточку — предупреждаем и идём дальше.
    if (!пробно) throw e;
    console.log('ВНИМАНИЕ: ' + e.message);
  }
  const прил = await приложениеИлиОшибка();
  const номер = аргумент('build');
  const строкаВерсии = аргумент('version', '1.0');
  const сборка = await найтиСборку(прил, номер);
  if (!сборка || сборка.attributes.processingState !== 'VALID') throw new Error(`Сборка ${номер} ещё не готова у Apple.`);

  const версия = await версияДляПравки(прил, строкаВерсии);
  await api('PATCH', `/v1/appStoreVersions/${версия.id}/relationships/build`, { data: { type: 'builds', id: сборка.id } });
  console.log(`к версии ${версия.attributes.versionString} привязана сборка ${номер}`);
  /*
   * Выпуск — вручную: одобренное приложение ждёт, пока владелец не нажмёт
   * «Выпустить». За это время Apple успевает рассмотреть просьбу сделать
   * приложение доступным только по ссылке, и в общий поиск App Store оно
   * не попадает ни на день.
   */
  await api('PATCH', `/v1/appStoreVersions/${версия.id}`, {
    data: {
      type: 'appStoreVersions', id: версия.id,
      attributes: { copyright: `${new Date().getFullYear()} Diamonds`, releaseType: 'MANUAL' },
    },
  });
  console.log('авторские права указаны, выпуск после одобрения — вручную');

  const лок = await описание(версия);
  await сведенияОПриложении(прил);
  await данныеДляПроверяющего(версия);
  await скриншоты(лок);

  if (пробно) { console.log('всё заполнено; отправка на проверку не запрашивалась'); return; }

  const открытые = await api('GET', `/v1/reviewSubmissions?filter[app]=${прил.id}&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=5`);
  let заявка = (открытые.data || [])[0];
  if (!заявка) {
    заявка = (await api('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: прил.id } } } },
    })).data;
  }
  try {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: заявка.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: версия.id } },
        },
      },
    });
  } catch (e) {
    // Версия уже в этой заявке — после прошлой неудачной попытки. Это не ошибка.
    if (e.status !== 409) throw e;
  }
  try {
    await api('PATCH', `/v1/reviewSubmissions/${заявка.id}`, {
      data: { type: 'reviewSubmissions', id: заявка.id, attributes: { submitted: true } },
    });
  } catch (e) {
    throw new Error('Apple не принял заявку. Чаще всего не заполнены на сайте «Конфиденциальность приложения» ' +
      'или «Цена и доступность» — см. инструкцию. Ответ Apple: ' + e.message);
  }
  console.log('ОТПРАВЛЕНО НА ПРОВЕРКУ APPLE');
}

const команды = { check, team, pem, 'prepare-signing': prepareSigning, 'cleanup-signing': cleanupSigning, 'wait-build': waitBuild, submit };
const команда = команды[process.argv[2]];
if (!команда) {
  console.error('Команды: ' + Object.keys(команды).join(', '));
  process.exit(2);
}
команда().catch(e => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
