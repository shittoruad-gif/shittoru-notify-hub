/**
 * しっとる 通知ハブ
 *
 * 目的:
 *   しっとるの全サービスから、お客様の公式LINEへ通知・レポートを送るための共通の口。
 *   これが無いと、サービスごと・お客様ごとにチャネルトークンと宛先を設定することになり、
 *   お客様が増えるたびに設定作業が発生する（＝人件費が乗る）。
 *
 * 考え方:
 *   ・しっとる専用の「お知らせ用」公式LINE を1つだけ作る（チャネルは1つ）
 *   ・お客様には「連携用リンク」を1本お渡しする。開いて送信ボタンを押すだけで紐づく
 *   ・以降、口コミレポート・広告レポート・新刊のお知らせなど、
 *     どのサービスからでも「コード」を指定して送れる
 *
 * つなぎ方（お客様の操作は2タップ）:
 *   1. お渡ししたリンク https://notify.s-toru.com/link/XXXX を開く
 *   2. 「LINEで連携する」を押す → 公式LINEのトークがコード入力済みで開く → 送信
 *   友だち追加がまだでも、このリンクから追加まで一気に進む。
 *   コードを手で打ってもらう運用は、打ち間違い・全角half角・大文字小文字で必ず事故るため採らない。
 *   （それでも手入力された場合に備えて、照合はかなり緩くしてある。normalize() を参照）
 *
 * 通数について:
 *   プッシュはLINEの配信通数にカウントされる（あいさつ・応答メッセージはカウント外）。
 *   月1回のレポートなら、フリープラン（月200通）で200社まで無料で回る。
 *
 * 環境変数:
 *   LINE_TOKEN       … お知らせ用チャネルのアクセストークン
 *   LINE_SECRET      … 同 チャネルシークレット（署名検証）
 *   LINE_BASIC_ID    … 公式LINEのID（例 @163zhsmk）。連携リンクの組み立てに使う
 *   PUBLIC_URL       … このハブの公開URL（例 https://notify.s-toru.com）
 *   WEBHOOK_PATH     … Webhookの受け口パス（推測されない文字列）
 *   NOTIFY_API_KEY   … 各サービスが送信APIを叩くときの鍵
 *   OWNER_ID         … 運営（三上様）のuserId。登録通知や失敗通知を送る先
 *   DB_PATH          … SQLiteの置き場所（既定 /app/data/hub.db）
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const LINE_TOKEN = process.env.LINE_TOKEN || '';
const LINE_SECRET = process.env.LINE_SECRET || '';
const LINE_BASIC_ID = process.env.LINE_BASIC_ID || '@163zhsmk';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://notify.s-toru.com').replace(/\/$/, '');
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || 'webhook';
const NOTIFY_API_KEY = process.env.NOTIFY_API_KEY || '';
const OWNER_ID = process.env.OWNER_ID || '';
const DB_PATH = process.env.DB_PATH || '/app/data/hub.db';
const PORT = process.env.PORT || 3000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS recipients (
  code         TEXT PRIMARY KEY,          -- ご契約ごとにお渡しするコード（例 SH-K7QX9M）
  shop_name    TEXT NOT NULL DEFAULT '',  -- お店の名前（運営が登録時に入れる）
  line_user_id TEXT,                      -- 連携リンクからの送信で埋まる
  linked_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  service    TEXT NOT NULL,               -- どのサービスからの通知か
  dedupe_key TEXT,                        -- 同じものを二度送らないための鍵（例 kuchikomi:2026-08）
  ok         INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_dedupe ON sends(code, dedupe_key) WHERE dedupe_key IS NOT NULL;
`);

/**
 * 後から足した列。既存のDBでも動くように、無ければ足す。
 * services … そのお店がご契約中のサービス [{name,url}] のJSON。
 *             リッチメニューの「ご利用中のサービス」で、お店ごとの入口を返すために使う。
 * text     … 送った本文。「今月のレポート」ボタンで読み返せるようにするため。
 */
for (const [table, col, ddl] of [
  ['recipients', 'services', 'ALTER TABLE recipients ADD COLUMN services TEXT'],
  ['sends', 'text', 'ALTER TABLE sends ADD COLUMN text TEXT'],
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(ddl);
}

const now = () => Date.now();
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const html = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * コードの照合をかなり緩くする。
 * 想定する事故: 全角で打つ／小文字で打つ／ハイフンを抜く／前後に「これです」等の文字が混ざる。
 * NFKCで全角を半角に寄せ、英数字だけ残して大文字化する。
 */
const normalize = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** 打ち間違えようのない文字だけでコードを作る（I/O/0/1 を使わない） */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = '';
    const buf = crypto.randomBytes(6);
    for (const b of buf) s += ALPHABET[b % ALPHABET.length];
    const code = 'SH-' + s;
    if (!db.prepare('SELECT 1 FROM recipients WHERE code = ?').get(code)) return code;
  }
  throw new Error('コードを作れませんでした');
}

/** お客様にお渡しする連携リンク */
const linkUrl = (code) => `${PUBLIC_URL}/link/${encodeURIComponent(code)}`;
/** LINEのトークをコード入力済みで開くURL（友だち未追加なら追加へ誘導される） */
const oaMessageUrl = (code) => `https://line.me/R/oaMessage/${LINE_BASIC_ID}/?${encodeURIComponent(code)}`;

async function lineApi(p, method, body) {
  const res = await fetch('https://api.line.me' + p, {
    method,
    headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) console.error('LINE API error', p, res.status, text.slice(0, 200));
  return { ok: res.ok, status: res.status, text };
}

const push = (to, text) =>
  lineApi('/v2/bot/message/push', 'POST', { to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] });
const reply = (replyToken, text) =>
  lineApi('/v2/bot/message/reply', 'POST', { replyToken, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] });

function verifySignature(raw, signature) {
  if (!LINE_SECRET) return false;
  const mac = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(signature || '')));
  } catch {
    return false;
  }
}

// ── Webhook：友だち追加とコード照合 ───────────────────────────
const GUIDE =
  'ご登録ありがとうございます。\n' +
  '株式会社しっとるです。毎月のご利用状況やお知らせを、こちらにお送りします。\n\n' +
  'お手元に、担当からお送りした「連携用のリンク」がございます。\n' +
  'そちらを開いて、青いボタンを押していただくと連携が完了します。\n\n' +
  'リンクが見当たらない場合は、このトークに「リンク」とだけ送ってください。担当からお送りし直します。';

/**
 * メッセージ本文から、登録済みのコードを探す。
 * 完全一致にこだわらず、正規化した本文の中に含まれていれば拾う。
 * （短いコードでの誤爆を避けるため、正規化後6文字以上のものだけを対象にする）
 */
function findRecipientByText(text) {
  const norm = normalize(text);
  if (!norm) return null;
  const rows = db.prepare('SELECT * FROM recipients').all();
  let best = null;
  for (const r of rows) {
    const nc = normalize(r.code);
    if (nc.length < 6) continue;
    if (norm === nc) return r; // 完全一致が最優先
    if (norm.includes(nc) && (!best || nc.length > normalize(best.code).length)) best = r;
  }
  return best;
}

/**
 * リッチメニューのボタン（postback）を処理する。
 *
 * なぜURLではなくpostbackなのか:
 *   リッチメニューは全員に同じものが表示される。ボタンにURLを直接入れると、
 *   全店舗が同じURLに飛んでしまう。かといってお店ごとにメニューを作り分けると、
 *   ご契約のたびに画像とメニューを1つずつ作ることになり工数が積み上がる。
 *   postbackなら「押した人のuserId」が届くので、
 *   メニューは1つのまま、そのお店に合わせた内容を返せる。
 *
 * 返信は reply（応答）なので、LINEの配信通数を消費しない。
 */
async function handlePostback(ev, userId) {
  const action = String((ev.postback && ev.postback.data) || '');
  const row = db.prepare('SELECT * FROM recipients WHERE line_user_id = ?').get(userId);

  if (!row) {
    return reply(
      ev.replyToken,
      'まだ連携が済んでいません。\n担当からお送りした「連携用のリンク」を開いて、青いボタンを押してください。\n\nリンクが見当たらない場合は、担当までご連絡ください。'
    );
  }

  if (action === 'report') {
    const last = db
      .prepare('SELECT * FROM sends WHERE code = ? AND ok = 1 AND text IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get(row.code);
    if (!last) {
      return reply(
        ev.replyToken,
        `${row.shop_name} 様\n\nまだお送りしたレポートがありません。\n毎月1日の朝に、前の月のご利用状況をこちらへお届けします。`
      );
    }
    const d = new Date(last.created_at + 9 * 3600 * 1000);
    const stamp = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日にお送りした内容`;
    return reply(ev.replyToken, `【${stamp}】\n\n${last.text}`);
  }

  if (action === 'services') {
    let list = [];
    try { list = JSON.parse(row.services || '[]'); } catch { list = []; }
    if (!list.length) {
      return reply(
        ev.replyToken,
        `${row.shop_name} 様\n\nこちらから開けるサービスの登録がまだありません。\n担当までご連絡いただければ、すぐにご用意します。`
      );
    }
    const body = list.map((s) => `■ ${s.name}\n${s.url}`).join('\n\n');
    return reply(ev.replyToken, `${row.shop_name} 様\n\nご利用中のサービスです。\n\n${body}`);
  }

  if (action === 'contact') {
    if (OWNER_ID) {
      await push(OWNER_ID, `お客様から「担当に相談する」が押されました。\n\n${row.shop_name}（${row.code}）\n\nこのお客様のトークからご返信ください。`);
    }
    return reply(
      ev.replyToken,
      `${row.shop_name} 様\n\nご連絡ありがとうございます。担当へお伝えしました。\n折り返しご連絡いたしますので、少々お待ちください。\n\nお急ぎの場合は、このままご用件を書いて送っていただいても大丈夫です。`
    );
  }

  return reply(ev.replyToken, '恐れ入ります。もう一度お試しください。');
}

async function handleEvent(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;

  if (ev.type === 'postback') return handlePostback(ev, userId);

  if (ev.type === 'follow') {
    await reply(ev.replyToken, GUIDE);
    if (OWNER_ID) await push(OWNER_ID, 'お知らせ用LINEに友だち追加がありました。\nまだ連携（コード送信）は済んでいません。\nuserId: ' + userId);
    return;
  }
  if (ev.type === 'unfollow') {
    db.prepare('UPDATE recipients SET line_user_id = NULL, linked_at = NULL WHERE line_user_id = ?').run(userId);
    if (OWNER_ID) await push(OWNER_ID, 'お知らせ用LINEがブロック（または友だち解除）されました。\nuserId: ' + userId);
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

  const raw = String(ev.message.text || '').trim();

  // 連携済みの方が「リンク」等と送ってきたとき用の案内
  const already = db.prepare('SELECT * FROM recipients WHERE line_user_id = ?').get(userId);

  const row = findRecipientByText(raw);
  if (!row) {
    if (already) {
      // 連携済みの方の書き込みは、ご用件とみなして担当へ回す。
      // 「担当までご連絡ください」と突き放すと、せっかく書いてくださった内容が宙に浮くため。
      if (OWNER_ID) {
        await push(OWNER_ID, `お客様からメッセージが届きました。\n\n${already.shop_name}（${already.code}）\n\n${raw.slice(0, 800)}`);
      }
      await reply(ev.replyToken, `${already.shop_name} 様\n\nご連絡ありがとうございます。担当へお伝えしました。\n折り返しご連絡いたしますので、少々お待ちください。`);
    } else {
      await reply(ev.replyToken, '恐れ入ります。連携用のリンクから、青いボタンを押してお進みください。\n\nリンクが見当たらない場合は、担当までご連絡ください。こちらからお送りし直します。');
    }
    return;
  }

  if (row.line_user_id === userId) {
    await reply(ev.replyToken, `${row.shop_name} 様の連携は、すでに完了しています。\nこのままお待ちください。毎月のご利用状況を自動でお送りします。`);
    return;
  }

  db.prepare('UPDATE recipients SET line_user_id = ?, linked_at = ? WHERE code = ?').run(userId, now(), row.code);
  await reply(
    ev.replyToken,
    `${row.shop_name || 'お客様'} 様\n\n連携が完了しました。\n\n毎月のご利用状況や、サービスからのお知らせを、このトークにお送りします。こちらでの操作は、もう必要ありません。`
  );
  if (OWNER_ID) await push(OWNER_ID, `連携が完了しました。\n${row.shop_name}（${row.code}）`);
}

// ── 連携ページ：お客様が開くのはここだけ ──────────────────────
const PAGE_CSS = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f5f6f7;color:#0E2A38;
    font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;
    line-height:1.8;-webkit-text-size-adjust:100%}
  .wrap{max-width:520px;margin:0 auto;padding:28px 20px 56px}
  .card{background:#fff;border-radius:14px;padding:26px 22px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .brand{font-size:13px;letter-spacing:.08em;color:#0E8388;font-weight:700;margin:0 0 6px}
  h1{font-size:21px;margin:0 0 4px;line-height:1.5}
  .shop{font-size:15px;color:#5a6b74;margin:0 0 22px}
  .btn{display:block;text-align:center;background:#06C755;color:#fff;text-decoration:none;
    font-size:18px;font-weight:700;padding:17px 16px;border-radius:10px;margin:0 0 14px}
  .btn:active{opacity:.85}
  .steps{margin:24px 0 0;padding:0;list-style:none;counter-reset:s}
  .steps li{counter-increment:s;position:relative;padding:0 0 14px 34px;font-size:15px}
  .steps li::before{content:counter(s);position:absolute;left:0;top:2px;width:23px;height:23px;
    background:#0E8388;color:#fff;border-radius:50%;text-align:center;line-height:23px;font-size:13px;font-weight:700}
  hr{border:0;border-top:1px solid #e6e9eb;margin:26px 0}
  h2{font-size:15px;margin:0 0 10px}
  .qr{text-align:center;padding:6px 0 2px}
  .qr svg{width:180px;height:180px}
  .note{font-size:13px;color:#5a6b74;margin:8px 0 0}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;letter-spacing:.06em;
    background:#f0f2f3;border-radius:7px;padding:9px 13px;display:inline-block;margin:4px 0}
  .done{background:#eef7f1;border:1px solid #cfe6d8;border-radius:10px;padding:16px 18px;margin:0 0 20px;font-size:15px}
  .foot{text-align:center;font-size:12px;color:#8a969c;margin:22px 0 0}
`;

function pageShell(title, inner) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap"><div class="card">${inner}</div>
<p class="foot">株式会社しっとる</p></div></body></html>`;
}

async function handleLinkPage(code, res) {
  const row = db.prepare('SELECT * FROM recipients WHERE code = ?').get(String(code).toUpperCase());
  if (!row) {
    return html(
      res,
      404,
      pageShell(
        'リンクが見つかりません',
        `<p class="brand">しっとる お知らせ用LINE</p>
         <h1>このリンクは使えません</h1>
         <p class="shop">お手数ですが、担当までご連絡ください。新しいリンクをお送りします。</p>`
      )
    );
  }

  if (row.line_user_id) {
    return html(
      res,
      200,
      pageShell(
        '連携済み',
        `<p class="brand">しっとる お知らせ用LINE</p>
         <h1>連携は完了しています</h1>
         <p class="shop">${esc(row.shop_name)} 様</p>
         <div class="done">毎月のご利用状況は、公式LINEに自動でお送りします。<br>こちらでの操作は必要ありません。</div>
         <p class="note">お店を変更したい、届かない、といった場合は担当までご連絡ください。</p>`
      )
    );
  }

  const oa = oaMessageUrl(row.code);
  let qr = '';
  try {
    qr = await QRCode.toString(oa, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  } catch (e) {
    console.error('QR生成に失敗', e.message);
  }

  return html(
    res,
    200,
    pageShell(
      'LINEを連携する',
      `<p class="brand">しっとる お知らせ用LINE</p>
       <h1>公式LINEを連携します</h1>
       <p class="shop">${esc(row.shop_name)} 様</p>

       <a class="btn" href="${esc(oa)}">LINEで連携する</a>
       <p class="note">ボタンを押すとLINEが開きます。文字はすでに入力された状態になっていますので、<strong>そのまま送信してください。</strong>友だち追加がまだの場合も、この流れで追加まで進みます。</p>

       <ol class="steps">
         <li>上のボタンを押す</li>
         <li>LINEが開く（友だち追加の画面が出たら追加する）</li>
         <li>入力済みの文字を、そのまま送信する</li>
         <li>「連携が完了しました」と返ってきたら終わりです</li>
       </ol>

       <hr>
       <h2>パソコンでご覧の場合</h2>
       <p class="note">スマートフォンのカメラで、このQRコードを読み取ってください。</p>
       <div class="qr">${qr}</div>

       <hr>
       <h2>うまくいかないとき</h2>
       <p class="note">公式LINE <strong>${esc(LINE_BASIC_ID)}</strong> を友だち追加して、下の文字をそのまま送っていただいても連携できます。</p>
       <p><span class="code">${esc(row.code)}</span></p>
       <p class="note">大文字・小文字、全角・半角は問いません。</p>`
    )
  );
}

// ── 送信API：各サービスから叩く ────────────────────────────
async function handleNotify(body, res) {
  const { code, service, text, dedupeKey } = body || {};
  if (!code || !service || !text) return json(res, 400, { error: 'code, service, text は必須です' });

  const row = db.prepare('SELECT * FROM recipients WHERE code = ?').get(String(code).toUpperCase());
  if (!row) return json(res, 404, { error: 'コードが見つかりません' });
  if (!row.line_user_id) {
    if (OWNER_ID) {
      await push(
        OWNER_ID,
        `通知を送れませんでした。\nお店: ${row.shop_name}\nサービス: ${service}\n\nまだLINEの連携が済んでいません。連携リンクをお渡しください。\n${linkUrl(row.code)}`
      );
    }
    return json(res, 409, { error: 'まだLINEの連携が済んでいません', shop: row.shop_name, linkUrl: linkUrl(row.code) });
  }

  if (dedupeKey) {
    try {
      db.prepare('INSERT INTO sends (code, service, dedupe_key, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.code, service, dedupeKey, text, now());
    } catch {
      return json(res, 200, { skipped: true, reason: '同じ内容を送信済みです' });
    }
  }

  const r = await push(row.line_user_id, text);
  if (dedupeKey) {
    db.prepare('UPDATE sends SET ok = ?, detail = ? WHERE code = ? AND dedupe_key = ?')
      .run(r.ok ? 1 : 0, r.ok ? null : r.text.slice(0, 200), row.code, dedupeKey);
  } else {
    db.prepare('INSERT INTO sends (code, service, ok, detail, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.code, service, r.ok ? 1 : 0, r.ok ? null : r.text.slice(0, 200), text, now());
  }
  if (!r.ok && OWNER_ID) {
    await push(OWNER_ID, `通知の送信に失敗しました。\nお店: ${row.shop_name}\nサービス: ${service}\n${r.text.slice(0, 150)}`);
  }
  return json(res, r.ok ? 200 : 502, { sent: r.ok, shop: row.shop_name });
}

// ── 運営API：宛先の登録・一覧 ─────────────────────────────
function handleRecipients(method, body, res) {
  if (method === 'GET') {
    const rows = db
      .prepare('SELECT code, shop_name, (line_user_id IS NOT NULL) AS linked, linked_at FROM recipients ORDER BY created_at')
      .all();
    return json(res, 200, { recipients: rows.map((r) => ({ ...r, linkUrl: linkUrl(r.code) })) });
  }
  const { shopName, code, services } = body || {};
  if (!shopName) return json(res, 400, { error: 'shopName は必須です' });
  // コードは自動発行する。運営が手で決めると推測できてしまうため。
  const c = code ? String(code).toUpperCase() : newCode();

  const clean = Array.isArray(services)
    ? services.filter((s) => s && s.name && s.url).map((s) => ({ name: String(s.name), url: String(s.url) }))
    : null;

  const existing = db.prepare('SELECT * FROM recipients WHERE code = ?').get(c);

  /**
   * サービス一覧は「足す」。置き換えない。
   *
   * 1つのお店が口コミアプリとKeiroの両方を使うことがある。
   * それぞれのアプリが自分のぶんだけを送ってくるので、
   * 上書きにすると後から登録したほうだけが残り、もう一方が消える。
   * 名前をキーにして、同じ名前ならURLを新しいほうで更新する。
   */
  let merged = clean;
  if (existing && clean) {
    let prev = [];
    try { prev = JSON.parse(existing.services || '[]'); } catch { prev = []; }
    const byName = new Map(prev.map((s) => [s.name, s]));
    for (const s of clean) byName.set(s.name, s);
    merged = [...byName.values()];
  }

  if (existing) {
    db.prepare('UPDATE recipients SET shop_name = ?, services = COALESCE(?, services) WHERE code = ?')
      .run(shopName, merged ? JSON.stringify(merged) : null, c);
  } else {
    db.prepare('INSERT INTO recipients (code, shop_name, services, created_at) VALUES (?, ?, ?, ?)')
      .run(c, shopName, merged ? JSON.stringify(merged) : null, now());
  }

  const saved = db.prepare('SELECT * FROM recipients WHERE code = ?').get(c);
  return json(res, 200, {
    ok: true,
    code: c,
    shopName,
    services: JSON.parse(saved.services || '[]'),
    linked: Boolean(saved.line_user_id),
    linkUrl: linkUrl(c),
  });
}

// ── サーバー ──────────────────────────────────────────────
http
  .createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      const n = db.prepare('SELECT COUNT(*) c FROM recipients').get().c;
      const linked = db.prepare('SELECT COUNT(*) c FROM recipients WHERE line_user_id IS NOT NULL').get().c;
      return json(res, 200, { ok: true, recipients: n, linked });
    }

    // お客様が開く連携ページ（認証なし。コードは推測できない文字列にしてある）
    if (req.method === 'GET' && url.startsWith('/link/')) {
      const code = decodeURIComponent(url.slice('/link/'.length));
      return handleLinkPage(code, res).catch((e) => {
        console.error('link page error', e.message);
        html(res, 500, pageShell('エラー', '<h1>表示できませんでした</h1><p>お手数ですが、担当までご連絡ください。</p>'));
      });
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        // LINE Webhook
        if (req.method === 'POST' && url === `/webhook/${WEBHOOK_PATH}`) {
          if (!verifySignature(raw, req.headers['x-line-signature'])) {
            res.writeHead(401);
            return res.end('invalid signature');
          }
          res.writeHead(200);
          res.end('OK');
          const events = JSON.parse(raw || '{}').events || [];
          for (const ev of events) {
            try { await handleEvent(ev); } catch (e) { console.error('event error', e.message); }
          }
          return;
        }

        // 認証が要るAPI
        const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!NOTIFY_API_KEY || key !== NOTIFY_API_KEY) {
          res.writeHead(401);
          return res.end('unauthorized');
        }
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === 'POST' && url === '/notify') return handleNotify(body, res);
        if (url === '/recipients') return handleRecipients(req.method, body, res);
        res.writeHead(404);
        res.end();
      } catch (e) {
        console.error('handler error', e.message);
        json(res, 500, { error: 'internal' });
      }
    });
  })
  .listen(PORT, () => console.log('しっとる通知ハブ 起動 port=' + PORT + ' db=' + DB_PATH));
