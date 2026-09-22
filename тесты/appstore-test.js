'use strict';
/*
 * Робот App Store (ios/tools/appstore.mjs) — на поддельном App Store Connect.
 *
 * Настоящий App Store Connect в проверках недоступен: нужен ключ владельца,
 * и каждая ошибка там стоит дня в очереди на проверку. Поэтому здесь поднят
 * поддельный — он отвечает так, как отвечает Apple, и записывает, что с ним
 * делали. Проверяется то, что без этого выяснилось бы только в бою:
 *   • пропуск (JWT) подписан ключом и устроен так, как требует Apple;
 *   • сертификаты и профили робота убираются, чужие — никогда;
 *   • без карточки приложения робот останавливается сразу и объясняет, что делать;
 *   • ключ из секрета в любом виде превращается в правильный файл;
 *   • описание, скриншоты, данные для проверяющего и отправка — целиком;
 *   • если демо-версия не пускает, на проверку ничего не уходит.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const РОБОТ = path.join(ROOT, 'ios', 'tools', 'appstore.mjs');
const РАБОТА = fs.mkdtempSync(path.join(os.tmpdir(), 'asher-appstore-'));

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(JSON.stringify(доп)).slice(0, 300)); }
};

// ---------- Поддельный App Store Connect ----------

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const КЛЮЧ_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const из64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let состояние;
function сначала() {
  состояние = {
    вызовы: [],
    пропуска: [],
    bundleIds: [],
    возможности: [],
    certificates: [{ id: 'CHUZHOY', attributes: {} }],
    profiles: [
      // Профиль, заведённый человеком, — робот не должен его трогать.
      { id: 'P-HUMAN', attributes: { name: 'Diamonds manual', uuid: 'u-human' }, certs: ['CHUZHOY'] },
    ],
    apps: [{ id: 'APP1', attributes: { bundleId: 'kg.diamonds.crm', name: 'Diamonds.kg' } }],
    builds: [{ id: 'BLD1', attributes: { version: '7.1', processingState: 'PROCESSING' } }],
    опросовСборки: 0,
    versions: [{ id: 'VER1', attributes: { versionString: '1.0', appStoreState: 'PREPARE_FOR_SUBMISSION', appVersionState: 'PREPARE_FOR_SUBMISSION' } }],
    localizations: [{ id: 'LOC1', attributes: { locale: 'ru' } }],
    reviewDetail: null,
    screenshotSets: [],
    screenshots: [],
    загружено: {},
    submissions: [],
    предельныеКлючевые: 100,
    отказСертификата: false,
    следующий: 1,
  };
}
сначала();

const новыйId = префикс => `${префикс}${состояние.следующий++}`;

function проверитьПропуск(req) {
  const [, token] = String(req.headers.authorization || '').split(' ');
  const [г, т, п] = String(token || '').split('.');
  if (!п) return false;
  const голова = JSON.parse(из64(г));
  const тело = JSON.parse(из64(т));
  const верно = crypto.verify('sha256', Buffer.from(`${г}.${т}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, из64(п));
  состояние.пропуска.push({ голова, тело, верно });
  return верно;
}

const апи = http.createServer((req, res) => {
  let тело = [];
  req.on('data', ч => тело.push(ч));
  req.on('end', () => {
    тело = Buffer.concat(тело);
    const адрес = new URL(req.url, 'http://x');
    const путь = адрес.pathname;
    const ответ = (код, json) => { res.writeHead(код, { 'Content-Type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
    const ошибка = (код, detail) => ответ(код, { errors: [{ status: String(код), title: 'Ошибка', detail }] });

    // Загрузка скриншота идёт не в API, а на отдельный адрес — без пропуска.
    if (путь.startsWith('/upload/')) {
      состояние.загружено[путь.split('/').pop()] = тело.length;
      return ответ(200);
    }
    let данные = null;
    try { данные = тело.length ? JSON.parse(тело) : null; } catch { return ошибка(400, 'не JSON'); }
    состояние.вызовы.push({ метод: req.method, путь, запрос: адрес.search, данные });
    if (!проверитьПропуск(req)) return ошибка(401, 'пропуск не подписан');
    const м = req.method;
    let x;

    if (м === 'GET' && путь === '/v1/bundleIds') {
      return ответ(200, { data: состояние.bundleIds.filter(b => b.attributes.identifier === адрес.searchParams.get('filter[identifier]')) });
    }
    if (м === 'POST' && путь === '/v1/bundleIds') {
      const б = { type: 'bundleIds', id: новыйId('B'), attributes: { ...данные.data.attributes, seedId: 'TEAM123456' } };
      состояние.bundleIds.push(б);
      return ответ(201, { data: б });
    }
    if ((x = путь.match(/^\/v1\/bundleIds\/([^/]+)\/bundleIdCapabilities$/)) && м === 'GET') {
      return ответ(200, { data: состояние.возможности.filter(в => в.bundle === x[1]).map(в => ({ id: в.id, attributes: { capabilityType: в.тип } })) });
    }
    if (м === 'POST' && путь === '/v1/bundleIdCapabilities') {
      состояние.возможности.push({ id: новыйId('CAP'), bundle: данные.data.relationships.bundleId.data.id, тип: данные.data.attributes.capabilityType });
      return ответ(201, { data: {} });
    }
    if (м === 'GET' && путь === '/v1/apps') {
      return ответ(200, { data: состояние.apps.filter(a => a.attributes.bundleId === адрес.searchParams.get('filter[bundleId]')) });
    }
    if (м === 'GET' && путь === '/v1/profiles') {
      return ответ(200, { data: состояние.profiles.map(p => ({ id: p.id, attributes: p.attributes })) });
    }
    if ((x = путь.match(/^\/v1\/profiles\/([^/]+)\/certificates$/)) && м === 'GET') {
      const п = состояние.profiles.find(p => p.id === x[1]);
      return п ? ответ(200, { data: п.certs.map(id => ({ id })) }) : ошибка(404, 'нет профиля');
    }
    if ((x = путь.match(/^\/v1\/profiles\/([^/]+)$/)) && м === 'DELETE') {
      const был = состояние.profiles.length;
      состояние.profiles = состояние.profiles.filter(p => p.id !== x[1]);
      return был === состояние.profiles.length ? ошибка(404, 'нет профиля') : ответ(204);
    }
    if ((x = путь.match(/^\/v1\/certificates\/([^/]+)$/)) && м === 'DELETE') {
      const был = состояние.certificates.length;
      состояние.certificates = состояние.certificates.filter(c => c.id !== x[1]);
      return был === состояние.certificates.length ? ошибка(404, 'нет сертификата') : ответ(204);
    }
    if (м === 'POST' && путь === '/v1/certificates') {
      if (состояние.отказСертификата) return ошибка(409, 'You already have a current Distribution certificate or a pending certificate request.');
      if (данные.data.attributes.certificateType !== 'DISTRIBUTION' || !данные.data.attributes.csrContent || /-----/.test(данные.data.attributes.csrContent)) {
        return ошибка(400, 'CSR или тип сертификата не те');
      }
      const с = { id: новыйId('CERT'), attributes: { certificateContent: Buffer.from('DER-сертификат').toString('base64') } };
      состояние.certificates.push(с);
      return ответ(201, { data: с });
    }
    if (м === 'POST' && путь === '/v1/profiles') {
      const d = данные.data;
      const п = {
        id: новыйId('PROF'), attributes: { name: d.attributes.name, uuid: 'uuid-' + состояние.следующий, profileContent: Buffer.from('профиль').toString('base64') },
        certs: d.relationships.certificates.data.map(c => c.id), bundle: d.relationships.bundleId.data.id, тип: d.attributes.profileType,
      };
      состояние.profiles.push(п);
      return ответ(201, { data: п });
    }
    if (м === 'GET' && путь === '/v1/builds') {
      const версия = адрес.searchParams.get('filter[version]');
      const с = состояние.builds.find(b => b.attributes.version === версия);
      if (с && ++состояние.опросовСборки >= 2) с.attributes.processingState = 'VALID';
      return ответ(200, { data: с ? [с] : [] });
    }
    if ((x = путь.match(/^\/v1\/apps\/([^/]+)\/appStoreVersions$/)) && м === 'GET') return ответ(200, { data: состояние.versions });
    if ((x = путь.match(/^\/v1\/appStoreVersions\/([^/]+)\/relationships\/build$/)) && м === 'PATCH') {
      состояние.versions[0].build = данные.data.id;
      return ответ(204);
    }
    if ((x = путь.match(/^\/v1\/appStoreVersions\/([^/]+)$/)) && м === 'PATCH') {
      Object.assign(состояние.versions[0].attributes, данные.data.attributes);
      return ответ(200, { data: состояние.versions[0] });
    }
    if ((x = путь.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/)) && м === 'GET') {
      return ответ(200, { data: состояние.localizations });
    }
    if ((x = путь.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)$/)) && м === 'PATCH') {
      const а = данные.data.attributes;
      if (Buffer.byteLength(а.keywords || '', 'utf8') > состояние.предельныеКлючевые) {
        return ответ(409, { errors: [{ status: '409', title: 'An attribute value is too long.', detail: 'The keywords field is too long', source: { pointer: '/data/attributes/keywords' } }] });
      }
      Object.assign(состояние.localizations[0].attributes, а);
      return ответ(200, { data: состояние.localizations[0] });
    }
    if ((x = путь.match(/^\/v1\/apps\/([^/]+)\/appInfos$/)) && м === 'GET') {
      return ответ(200, { data: [{ id: 'INFO1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION', state: 'PREPARE_FOR_SUBMISSION' } }] });
    }
    if (путь === '/v1/appInfos/INFO1' && м === 'PATCH') { состояние.категории = данные.data.relationships; return ответ(200, { data: {} }); }
    if (путь === '/v1/appInfos/INFO1/appInfoLocalizations' && м === 'GET') return ответ(200, { data: [{ id: 'AIL1', attributes: { locale: 'ru' } }] });
    if (путь === '/v1/appInfoLocalizations/AIL1' && м === 'PATCH') { состояние.сведения = данные.data.attributes; return ответ(200, { data: {} }); }
    if (путь === '/v1/appInfos/INFO1/ageRatingDeclaration' && м === 'GET') {
      return ответ(200, { data: { id: 'AGE1', attributes: { gamblingSimulated: null, violenceRealistic: 'NONE', unrestrictedWebAccess: null, messagingAndChat: null } } });
    }
    if (путь === '/v1/ageRatingDeclarations/AGE1' && м === 'PATCH') { состояние.возраст = данные.data.attributes; return ответ(200, { data: {} }); }
    if (путь === '/v1/apps/APP1' && м === 'PATCH') { состояние.права = данные.data.attributes; return ответ(200, { data: {} }); }
    if (путь === '/v1/appStoreVersions/VER1/appStoreReviewDetail' && м === 'GET') {
      return состояние.reviewDetail ? ответ(200, { data: состояние.reviewDetail }) : ответ(200, { data: null });
    }
    if (путь === '/v1/appStoreReviewDetails' && м === 'POST') {
      состояние.reviewDetail = { id: 'RD1', attributes: данные.data.attributes };
      return ответ(201, { data: состояние.reviewDetail });
    }
    if (путь === '/v1/appStoreReviewDetails/RD1' && м === 'PATCH') {
      состояние.reviewDetail.attributes = данные.data.attributes;
      return ответ(200, { data: состояние.reviewDetail });
    }
    if (путь === '/v1/appStoreVersionLocalizations/LOC1/appScreenshotSets' && м === 'GET') return ответ(200, { data: состояние.screenshotSets });
    if (путь === '/v1/appScreenshotSets' && м === 'POST') {
      const н = { id: новыйId('SET'), attributes: данные.data.attributes };
      состояние.screenshotSets.push(н);
      return ответ(201, { data: н });
    }
    if ((x = путь.match(/^\/v1\/appScreenshotSets\/([^/]+)\/appScreenshots$/)) && м === 'GET') {
      return ответ(200, { data: состояние.screenshots.map(с => ({ id: с.id })) });
    }
    if ((x = путь.match(/^\/v1\/appScreenshots\/([^/]+)$/)) && м === 'DELETE') {
      состояние.screenshots = состояние.screenshots.filter(с => с.id !== x[1]);
      return ответ(204);
    }
    if (путь === '/v1/appScreenshots' && м === 'POST') {
      const id = новыйId('SHOT');
      const размер = данные.data.attributes.fileSize;
      const половина = Math.ceil(размер / 2);
      состояние.screenshots.push({ id, имя: данные.data.attributes.fileName, размер });
      return ответ(201, {
        data: {
          id, attributes: {
            // Как у Apple: файл грузится частями, каждая на свой адрес.
            uploadOperations: [
              { method: 'PUT', url: `http://127.0.0.1:${апи.address().port}/upload/${id}-1`, offset: 0, length: половина, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
              { method: 'PUT', url: `http://127.0.0.1:${апи.address().port}/upload/${id}-2`, offset: половина, length: размер - половина, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
            ],
          },
        },
      });
    }
    if ((x = путь.match(/^\/v1\/appScreenshots\/([^/]+)$/)) && м === 'PATCH') {
      const с = состояние.screenshots.find(s => s.id === x[1]);
      Object.assign(с, данные.data.attributes);
      return ответ(200, { data: {} });
    }
    if (м === 'GET' && путь === '/v1/reviewSubmissions') return ответ(200, { data: состояние.submissions.filter(s => !s.submitted) });
    if (м === 'POST' && путь === '/v1/reviewSubmissions') {
      const з = { id: новыйId('SUB'), items: [], submitted: false };
      состояние.submissions.push(з);
      return ответ(201, { data: { id: з.id } });
    }
    if (м === 'POST' && путь === '/v1/reviewSubmissionItems') {
      const з = состояние.submissions.find(s => s.id === данные.data.relationships.reviewSubmission.data.id);
      з.items.push(данные.data.relationships.appStoreVersion.data.id);
      return ответ(201, { data: {} });
    }
    if ((x = путь.match(/^\/v1\/reviewSubmissions\/([^/]+)$/)) && м === 'PATCH') {
      const з = состояние.submissions.find(s => s.id === x[1]);
      з.submitted = данные.data.attributes.submitted === true;
      return ответ(200, { data: {} });
    }
    return ошибка(404, `поддельный Apple не знает ${м} ${путь}`);
  });
});

// Сайт и демо-версия, куда пойдёт проверяющий.
let демоПускает = true;
let контактыЕсть = true;
const сайт = http.createServer((req, res) => {
  if (req.url === '/api/login' && req.method === 'POST') {
    res.writeHead(демоПускает ? 200 : 401, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  if (req.url === '/privacy') { res.writeHead(200); return res.end('<h1>Политика</h1>'); }
  if (req.url === '/support') {
    res.writeHead(200);
    return res.end(контактыЕсть ? '<a href="mailto:shop@example.kg">shop@example.kg</a>' : '<li>контакты ещё не указаны</li>');
  }
  res.writeHead(404); res.end();
});

function робот(аргументы, доп = {}) {
  const выход = path.join(РАБОТА, 'github-output-' + Date.now() + Math.random());
  fs.writeFileSync(выход, '');
  return new Promise(resolve => {
    const п = spawn(process.execPath, [РОБОТ, ...аргументы], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        ASC_API: `http://127.0.0.1:${апи.address().port}`,
        ASC_ISSUER_ID: 'issuer-uuid-1234', ASC_KEY_ID: 'ASCKEY1234',
        // Ключ одной строкой и с пробелами — как его иногда вставляют в секрет.
        ASC_KEY_P8: '  ' + КЛЮЧ_PEM.replace(/\n/g, ' ') + '  ',
        ASC_POLL_MS: '20',
        ASC_SITE_BASE: `http://127.0.0.1:${сайт.address().port}/`,
        ASC_DEMO_BASE: `http://127.0.0.1:${сайт.address().port}`,
        REVIEW_CONTACT: 'Айбек;Исаков;+996555000111;shop@example.kg',
        GITHUB_OUTPUT: выход,
        ...доп,
      },
    });
    let текст = '';
    п.stdout.on('data', ч => { текст += ч; });
    п.stderr.on('data', ч => { текст += ч; });
    п.on('close', код => {
      const выводы = Object.fromEntries(fs.readFileSync(выход, 'utf8').split('\n').filter(Boolean).map(с => с.split('=')));
      resolve({ код, текст, выводы });
    });
  });
}

async function main() {
  await new Promise(r => апи.listen(0, '127.0.0.1', r));
  await new Promise(r => сайт.listen(0, '127.0.0.1', r));

  console.log('=== 1. Проверка ключа и карточки ===');
  let r = await робот(['check', '--need-app']);
  check('ключ принят, карточка найдена', r.код === 0 && /«Diamonds\.kg»/.test(r.текст), r.текст);
  check('идентификатор приложения заведён сам', состояние.bundleIds.length === 1
    && состояние.bundleIds[0].attributes.identifier === 'kg.diamonds.crm' && состояние.bundleIds[0].attributes.platform === 'IOS');
  check('и уведомления у него включены', состояние.возможности.some(в => в.тип === 'PUSH_NOTIFICATIONS'));
  check('номер команды отдан роботу GitHub', r.выводы.team_id === 'TEAM123456', r.выводы);
  const п = состояние.пропуска[0];
  check('пропуск подписан ES256 нашим ключом', п && п.верно && п.голова.alg === 'ES256' && п.голова.kid === 'ASCKEY1234', п);
  check('в пропуске — издатель, адресат App Store Connect и срок до 20 минут',
    п && п.тело.iss === 'issuer-uuid-1234' && п.тело.aud === 'appstoreconnect-v1' && п.тело.exp - п.тело.iat <= 20 * 60, п && п.тело);
  r = await робот(['check', '--need-app']);
  check('повторный запуск ничего не заводит заново', состояние.bundleIds.length === 1
    && состояние.возможности.length === 1);

  const карточка = состояние.apps.pop();
  r = await робот(['check', '--need-app']);
  check('без карточки приложения робот останавливается', r.код === 1, r.код);
  check('и объясняет, что создать и где', /Новое приложение/.test(r.текст) && /kg\.diamonds\.crm/.test(r.текст), r.текст);
  состояние.apps.push(карточка);

  console.log('\n=== 2. Ключ из секрета — в файл ===');
  const файлКлюча = path.join(РАБОТА, 'AuthKey.p8');
  r = await робот(['pem', '--env', 'ASC_KEY_P8', '--out', файлКлюча]);
  const записанный = fs.existsSync(файлКлюча) ? fs.readFileSync(файлКлюча, 'utf8') : '';
  check('ключ одной строкой превратился в правильный PEM', r.код === 0 && /^-----BEGIN PRIVATE KEY-----\n/.test(записанный)
    && записанный.split('\n').every(с => с.length <= 64), записанный.slice(0, 80));
  check('и это тот же ключ', (() => { try { return crypto.createPublicKey(crypto.createPrivateKey(записанный)).export({ type: 'spki', format: 'pem' }) === publicKey.export({ type: 'spki', format: 'pem' }); } catch { return false; } })());
  check('файл ключа закрыт от чужих глаз', (fs.statSync(файлКлюча).mode & 0o077) === 0, (fs.statSync(файлКлюча).mode & 0o777).toString(8));
  r = await робот(['pem', '--env', 'ASC_KEY_P8', '--out', файлКлюча + '2'], { ASC_KEY_P8: 'вставили что-то не то' });
  check('испорченный секрет не пишется, а объясняется', r.код === 1 && /\.p8/.test(r.текст) && !fs.existsSync(файлКлюча + '2'), r.текст);

  console.log('\n=== 3. Одноразовая подпись ===');
  // Остатки упавшей прошлой сборки: профиль робота с его сертификатом.
  состояние.certificates.push({ id: 'OLDCERT', attributes: {} });
  состояние.profiles.push({ id: 'P-OLD', attributes: { name: 'Diamonds robot 111', uuid: 'u-old' }, certs: ['OLDCERT'] });
  const подпись = path.join(РАБОТА, 'signing');
  const csr = path.join(РАБОТА, 'dist.csr');
  fs.writeFileSync(csr, '-----BEGIN CERTIFICATE REQUEST-----\nTUlJQ1dUQ0NBVUVDQVFBd0ZERVNNQkFHQTFVRUF3d0pSR2xo\nYlc5dVpITT0=\n-----END CERTIFICATE REQUEST-----\n');
  r = await робот(['prepare-signing', '--csr', csr, '--out', подпись, '--run', '4242']);
  check('подпись подготовлена', r.код === 0, r.текст);
  check('остатки прошлой сборки убраны: и профиль, и сертификат',
    !состояние.profiles.some(p => p.id === 'P-OLD') && !состояние.certificates.some(c => c.id === 'OLDCERT'));
  check('профиль и сертификат, заведённые человеком, не тронуты',
    состояние.profiles.some(p => p.id === 'P-HUMAN') && состояние.certificates.some(c => c.id === 'CHUZHOY'));
  const новый = состояние.profiles.find(p => p.attributes.name === 'Diamonds robot 4242');
  check('новый профиль — для App Store, на наш идентификатор и свежий сертификат',
    новый && новый.тип === 'IOS_APP_STORE' && новый.bundle === состояние.bundleIds[0].id && новый.certs.length === 1, новый);
  check('роботу GitHub отданы команда, имя и номер профиля',
    r.выводы.team_id === 'TEAM123456' && r.выводы.profile_name === 'Diamonds robot 4242' && /^uuid-/.test(r.выводы.profile_uuid), r.выводы);
  check('файлы сертификата и профиля лежат на месте',
    fs.existsSync(path.join(подпись, 'distribution.cer')) && fs.existsSync(path.join(подпись, 'profile.mobileprovision')));
  const вызовСерт = состояние.вызовы.find(в => в.метод === 'POST' && в.путь === '/v1/certificates');
  check('в Apple ушёл запрос без рамок PEM — как требует API', вызовСерт && !/-----/.test(вызовСерт.данные.data.attributes.csrContent));

  r = await робот(['cleanup-signing', '--out', подпись]);
  check('после сборки одноразовый сертификат отозван, профиль удалён', r.код === 0
    && !состояние.profiles.some(p => p.attributes.name === 'Diamonds robot 4242')
    && !состояние.certificates.some(c => c.id === новый.certs[0]), r.текст);
  check('чужое по-прежнему на месте', состояние.certificates.some(c => c.id === 'CHUZHOY'));

  состояние.отказСертификата = true;
  r = await робот(['prepare-signing', '--csr', csr, '--out', path.join(РАБОТА, 'signing2'), '--run', '4243']);
  check('упёрлись в предел сертификатов — понятное объяснение, где удалить лишний',
    r.код === 1 && /предел/.test(r.текст) && /Certificates/.test(r.текст), r.текст);
  состояние.отказСертификата = false;

  console.log('\n=== 4. Ждём обработку сборки ===');
  r = await робот(['wait-build', '--build', '7.1']);
  check('сборка дождалась VALID', r.код === 0 && r.выводы.build_id === 'BLD1', r.текст);

  console.log('\n=== 5. Демо-версия не пускает — на проверку ничего не уходит ===');
  демоПускает = false;
  const вызововДо = состояние.вызовы.length;
  r = await робот(['submit', '--build', '7.1', '--version', '1.0']);
  check('отправка остановлена', r.код === 1 && /admin \/ admin123/.test(r.текст), r.текст);
  check('в App Store Connect при этом ничего не менялось', состояние.вызовы.length === вызововДо,
    состояние.вызовы.slice(вызововДо).map(в => в.метод + ' ' + в.путь));
  демоПускает = true;
  контактыЕсть = false;
  r = await робот(['submit', '--build', '7.1', '--version', '1.0']);
  check('без телефона и почты на странице поддержки — тоже стоп, с подсказкой, где их заполнить',
    r.код === 1 && /Настройки → Магазин/.test(r.текст) && состояние.вызовы.length === вызововДо, r.текст);
  контактыЕсть = true;

  console.log('\n=== 6. Карточка, скриншоты, данные для проверяющего, отправка ===');
  состояние.предельныеКлючевые = 100;   // Apple считает байты: русские слова не влезут целиком
  r = await робот(['submit', '--build', '7.1', '--version', '1.0']);
  check('отправлено на проверку', r.код === 0 && /ОТПРАВЛЕНО НА ПРОВЕРКУ/.test(r.текст), r.текст.slice(-400));
  const версия = состояние.versions[0];
  check('к версии привязана сборка', версия.build === 'BLD1');
  check('выпуск после одобрения — вручную, авторские права указаны',
    версия.attributes.releaseType === 'MANUAL' && /Diamonds/.test(версия.attributes.copyright || ''), версия.attributes);
  const лок = состояние.localizations[0].attributes;
  check('описание взято из ios/appstore', лок.description === fs.readFileSync(path.join(ROOT, 'ios', 'appstore', 'ru', 'description.txt'), 'utf8').trim());
  check('ключевые слова ужаты под предел Apple, а не отвергнуты',
    Buffer.byteLength(лок.keywords, 'utf8') <= 100 && лок.keywords.length > 0 && /ключевые слова сокращены/.test(r.текст), лок.keywords);
  check('адреса поддержки и сайта', лок.supportUrl === 'https://diamonds.kg/support' && лок.marketingUrl === 'https://diamonds.kg/', лок);
  check('категории: «Бизнес» и «Продуктивность»',
    состояние.категории && состояние.категории.primaryCategory.data.id === 'BUSINESS' && состояние.категории.secondaryCategory.data.id === 'PRODUCTIVITY');
  check('подзаголовок и политика конфиденциальности',
    состояние.сведения && состояние.сведения.privacyPolicyUrl === 'https://diamonds.kg/privacy' && состояние.сведения.subtitle.length <= 30, состояние.сведения);
  check('возрастной рейтинг: на всё «нет»',
    состояние.возраст && состояние.возраст.violenceRealistic === 'NONE' && состояние.возраст.gamblingSimulated === 'NONE'
    && состояние.возраст.unrestrictedWebAccess === false && состояние.возраст.messagingAndChat === false, состояние.возраст);
  check('чужого контента в приложении нет', состояние.права && состояние.права.contentRightsDeclaration === 'DOES_NOT_USE_THIRD_PARTY_CONTENT');
  const рд = состояние.reviewDetail && состояние.reviewDetail.attributes;
  check('проверяющему — вход в демо и контакт из секрета',
    рд && рд.demoAccountName === 'admin' && рд.demoAccountPassword === 'admin123' && рд.demoAccountRequired === true
    && рд.contactFirstName === 'Айбек' && рд.contactPhone === '+996555000111' && рд.contactEmail === 'shop@example.kg', рд);
  check('и объяснение по-английски, как войти в демо', рд && /demo/i.test(рд.notes) && /admin123/.test(рд.notes));
  const файлы = fs.readdirSync(path.join(ROOT, 'ios', 'appstore', 'screenshots')).filter(f => f.endsWith('.png')).sort();
  check('скриншоты — в набор для экрана 6,9″', состояние.screenshotSets.length === 1
    && состояние.screenshotSets[0].attributes.screenshotDisplayType === 'APP_IPHONE_67');
  check('загружены все, по частям и целиком', состояние.screenshots.length === файлы.length && состояние.screenshots.every(с =>
    с.uploaded === true && (состояние.загружено[с.id + '-1'] + состояние.загружено[с.id + '-2']) === с.размер), состояние.screenshots);
  check('у каждого — контрольная сумма файла', состояние.screenshots.every(с => {
    const f = fs.readFileSync(path.join(ROOT, 'ios', 'appstore', 'screenshots', с.имя));
    return с.sourceFileChecksum === crypto.createHash('md5').update(f).digest('hex');
  }));
  const заявка = состояние.submissions[0];
  check('заявка на проверку содержит эту версию и отправлена', заявка && заявка.items.includes('VER1') && заявка.submitted === true, заявка);

  console.log('\n=== 7. Повторная отправка не плодит скриншоты ===');
  состояние.submissions = [];
  r = await робот(['submit', '--build', '7.1', '--version', '1.0', '--dry', '1']);
  check('пробный прогон: всё заполнено, но на проверку не ушло',
    r.код === 0 && /отправка на проверку не запрашивалась/.test(r.текст) && состояние.submissions.length === 0, r.текст.slice(-300));
  check('скриншотов столько же, сколько файлов', состояние.screenshots.length === файлы.length, состояние.screenshots.length);
  check('набор скриншотов тот же, новый не заведён', состояние.screenshotSets.length === 1);
  check('данные для проверяющего обновлены, а не заведены второй раз',
    состояние.вызовы.filter(в => в.путь === '/v1/appStoreReviewDetails' && в.метод === 'POST').length === 1);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
}

main()
  .catch(e => { console.error(e); fail++; })
  .finally(() => {
    апи.close();
    сайт.close();
    fs.rmSync(РАБОТА, { recursive: true, force: true });
    setTimeout(() => process.exit(fail ? 1 : 0), 100);
  });
