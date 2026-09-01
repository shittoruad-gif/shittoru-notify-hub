/**
 * リッチメニューの作成・画像アップロード・既定への設定
 *
 * 使い方（サーバー上で1回だけ実行する）:
 *   node richmenu.js            … 画像を作って登録し、全員の既定に設定する
 *   node richmenu.js --list     … いま登録されているリッチメニューを一覧する
 *   node richmenu.js --clean    … 既定以外の古いリッチメニューを消す
 *
 * なぜボタンをURLではなくpostbackにしているか:
 *   リッチメニューは全員に同じものが表示される。ボタンにURLを直接入れると
 *   全店舗が同じURLに飛んでしまう。お店ごとにメニューを作り分けると、
 *   ご契約のたびに画像とメニューを作ることになり工数が積み上がる。
 *   postbackなら押した人のuserIdが届くので、メニューは1つのまま
 *   そのお店に合わせた内容を返せる（server.js の handlePostback）。
 *
 * 画像について:
 *   2500x843（3分割・コンパクト版）。絵文字は使わず、線画と文字だけで作る。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LINE_TOKEN = process.env.LINE_TOKEN || '';
// 画像を作るだけ（--image）ならトークンは要らない
if (!LINE_TOKEN && process.argv[2] !== '--image') {
  console.error('LINE_TOKEN が設定されていません');
  process.exit(1);
}

const W = 2500;
const H = 843;
const INK = '#0E2A38';
const TEAL = '#0E8388';
const LINE_BG = '#FFFFFF';
const DIVIDER = '#DCE3E6';

const BUTTONS = [
  {
    label: '今月のレポート',
    sub: 'ご利用状況を読み返す',
    data: 'report',
    // 棒グラフ
    icon: `<g stroke="${TEAL}" stroke-width="9" fill="none" stroke-linecap="round">
             <path d="M8 78 L112 78"/>
             <path d="M30 78 L30 44"/><path d="M60 78 L60 20"/><path d="M90 78 L90 52"/>
           </g>`,
  },
  {
    label: 'ご利用中のサービス',
    sub: '開く画面のご案内',
    data: 'services',
    // 四角が並んだ一覧
    icon: `<g stroke="${TEAL}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round">
             <rect x="10" y="16" width="42" height="34" rx="7"/>
             <rect x="68" y="16" width="42" height="34" rx="7"/>
             <rect x="10" y="62" width="42" height="24" rx="7"/>
             <rect x="68" y="62" width="42" height="24" rx="7"/>
           </g>`,
  },
  {
    label: '担当に相談する',
    sub: 'そのまま書いてもOK',
    data: 'contact',
    // 吹き出し
    icon: `<g stroke="${TEAL}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 20 h96 a10 10 0 0 1 10 10 v38 a10 10 0 0 1 -10 10 h-52 l-24 20 v-20 h-20 a10 10 0 0 1 -10 -10 v-38 a10 10 0 0 1 10 -10 z"/>
           </g>`,
  },
];

function buildSvg() {
  const cell = W / 3;
  let cells = '';
  BUTTONS.forEach((b, i) => {
    const cx = cell * i + cell / 2;
    cells += `
      <g transform="translate(${cx - 60}, 210) scale(1.9)">${b.icon}</g>
      <text x="${cx}" y="590" text-anchor="middle" fill="${INK}"
        font-family="Hiragino Sans, Noto Sans JP, sans-serif" font-size="76" font-weight="600">${b.label}</text>
      <text x="${cx}" y="668" text-anchor="middle" fill="#7A888F"
        font-family="Hiragino Sans, Noto Sans JP, sans-serif" font-size="46">${b.sub}</text>`;
    if (i > 0) {
      cells += `<line x1="${cell * i}" y1="150" x2="${cell * i}" y2="${H - 150}" stroke="${DIVIDER}" stroke-width="3"/>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${LINE_BG}"/>
    <rect x="0" y="0" width="${W}" height="8" fill="${TEAL}"/>
    ${cells}
  </svg>`;
}

/**
 * 画像の取り方。
 * 本番のコンテナ（node:22-alpine）には画像変換のツールが入っていないため、
 * PNGはリポジトリに同梱してある richmenu.png をそのまま使う。
 * 作り直したいときは、手元で `node richmenu.js --image` を実行して差し替える
 * （手元には sharp がある。無い場合は rsvg-convert を使う）。
 */
const PNG_PATH = path.join(__dirname, 'richmenu.png');

function readPng() {
  if (!fs.existsSync(PNG_PATH)) {
    console.error(`${PNG_PATH} がありません。手元で「node richmenu.js --image」を実行して作ってください。`);
    process.exit(1);
  }
  return fs.readFileSync(PNG_PATH);
}

async function makeImage() {
  const svg = buildSvg();
  const svgPath = PNG_PATH.replace(/\.png$/, '.svg');
  fs.writeFileSync(svgPath, svg);
  try {
    const sharp = require('sharp');
    await sharp(Buffer.from(svg)).png().toFile(PNG_PATH);
  } catch {
    execFileSync('rsvg-convert', ['-w', String(W), '-h', String(H), '-o', PNG_PATH, svgPath]);
  }
  console.log('画像を書き出しました:', PNG_PATH, fs.statSync(PNG_PATH).size, 'バイト');
}

async function api(url, method, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + LINE_TOKEN, ...headers },
    body,
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

async function list() {
  const r = await api('https://api.line.me/v2/bot/richmenu/list', 'GET');
  const d = await api('https://api.line.me/v2/bot/user/all/richmenu', 'GET');
  console.log('登録済み:', r.status, r.text);
  console.log('既定:', d.status, d.text);
}

async function clean() {
  const cur = await api('https://api.line.me/v2/bot/user/all/richmenu', 'GET');
  let keep = null;
  try { keep = JSON.parse(cur.text).richMenuId; } catch {}
  const r = await api('https://api.line.me/v2/bot/richmenu/list', 'GET');
  const menus = JSON.parse(r.text).richmenus || [];
  for (const m of menus) {
    if (m.richMenuId === keep) continue;
    const d = await api('https://api.line.me/v2/bot/richmenu/' + m.richMenuId, 'DELETE');
    console.log('削除', m.richMenuId, d.status);
  }
}

async function main() {
  const cell = Math.floor(W / 3);
  const body = {
    size: { width: W, height: H },
    selected: true,
    name: 'shittoru-notify-' + new Date().toISOString().slice(0, 10),
    chatBarText: 'メニュー',
    areas: BUTTONS.map((b, i) => ({
      bounds: { x: cell * i, y: 0, width: i === 2 ? W - cell * 2 : cell, height: H },
      action: { type: 'postback', data: b.data, displayText: b.label },
    })),
  };

  const created = await api('https://api.line.me/v2/bot/richmenu', 'POST', JSON.stringify(body), {
    'Content-Type': 'application/json',
  });
  if (!created.ok) { console.error('作成に失敗', created.status, created.text); process.exit(1); }
  const id = JSON.parse(created.text).richMenuId;
  console.log('作成しました:', id);

  const png = readPng();
  console.log('画像:', png.length, 'バイト');

  const up = await api('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', 'POST', png, {
    'Content-Type': 'image/png',
  });
  if (!up.ok) { console.error('画像のアップロードに失敗', up.status, up.text); process.exit(1); }
  console.log('画像をアップロードしました');

  const def = await api('https://api.line.me/v2/bot/user/all/richmenu/' + id, 'POST');
  if (!def.ok) { console.error('既定への設定に失敗', def.status, def.text); process.exit(1); }
  console.log('全員の既定に設定しました');

  await clean();
  await list();
}

const arg = process.argv[2];
if (arg === '--image') makeImage();
else if (arg === '--list') list();
else if (arg === '--clean') clean().then(list);
else main();
