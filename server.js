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
 *   ・お客様はご契約時にそのLINEを友だち追加し、お渡ししたコードを送るだけ
 *   ・以降、口コミレポート・広告レポート・新刊のお知らせなど、
 *     どのサービスからでも「コード」を指定して送れる
 *
 * 通数について:
 *   プッシュはLINEの配信通数にカウントされる（あいさつ・応答メッセージはカウント外）。
 *   月1回のレポートなら、フリープラン（月200通）で200社まで無料で回る。
 *
 * 環境変数:
 *   LINE_TOKEN       … お知らせ用チャネルのアクセストークン
 *   LINE_SECRET      … 同 チャネルシークレット（署名検証）
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

const LINE_TOKEN = process.env.LINE_TOKEN || '';
const LINE_SECRET = process.env.LINE_SECRET || '';
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
  code         TEXT PRIMARY KEY,          -- ご契約ごとにお渡しするコード（例 SHOP-A1B2）
  shop_name    TEXT NOT NULL DEFAULT '',  -- お店の名前（運営が登録時に入れる）
  line_user_id TEXT,                      -- 友だち追加＋コード送信で埋まる
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

const now = () => Date.now();
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

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
  'しっとるからのお知らせをこちらにお送りします。\n\n' +
  'お手元にお渡ししているコード（例：SHOP-A1B2）を、そのまま送信してください。\n' +
  'コードが分からない場合は、担当までご連絡ください。';

async function handleEvent(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;

  if (ev.type === 'follow') {
    await reply(ev.replyToken, GUIDE);
    return;
  }
  if (ev.type === 'unfollow') {
    db.prepare('UPDATE recipients SET line_user_id = NULL, linked_at = NULL WHERE line_user_id = ?').run(userId);
    if (OWNER_ID) await push(OWNER_ID, 'お知らせ用LINEがブロック（または友だち解除）されました。\nuserId: ' + userId);
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

  const text = String(ev.message.text || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM recipients WHERE code = ?').get(text);
  if (!row) {
    // コード以外の発言には、案内だけ返す（雑談には応答しない）
    if (/^[A-Z0-9-]{4,20}$/.test(text)) {
      await reply(ev.replyToken, 'そのコードが見つかりませんでした。お手数ですが、担当までご確認ください。');
    }
    return;
  }
  db.prepare('UPDATE recipients SET line_user_id = ?, linked_at = ? WHERE code = ?').run(userId, now(), row.code);
  await reply(
    ev.replyToken,
    `${row.shop_name || 'お客様'} のご登録が完了しました。\n\n毎月のご利用状況や、サービスからのお知らせをこちらにお送りします。`
  );
  if (OWNER_ID) await push(OWNER_ID, `お知らせ用LINEに登録がありました。\n${row.shop_name}（${row.code}）`);
}

// ── 送信API：各サービスから叩く ────────────────────────────
async function handleNotify(body, res) {
  const { code, service, text, dedupeKey } = body || {};
  if (!code || !service || !text) return json(res, 400, { error: 'code, service, text は必須です' });

  const row = db.prepare('SELECT * FROM recipients WHERE code = ?').get(String(code).toUpperCase());
  if (!row) return json(res, 404, { error: 'コードが見つかりません' });
  if (!row.line_user_id) {
    return json(res, 409, { error: 'まだ友だち追加とコード送信が済んでいません', shop: row.shop_name });
  }

  if (dedupeKey) {
    try {
      db.prepare('INSERT INTO sends (code, service, dedupe_key, created_at) VALUES (?, ?, ?, ?)')
        .run(row.code, service, dedupeKey, now());
    } catch {
      return json(res, 200, { skipped: true, reason: '同じ内容を送信済みです' });
    }
  }

  const r = await push(row.line_user_id, text);
  if (dedupeKey) {
    db.prepare('UPDATE sends SET ok = ?, detail = ? WHERE code = ? AND dedupe_key = ?')
      .run(r.ok ? 1 : 0, r.ok ? null : r.text.slice(0, 200), row.code, dedupeKey);
  } else {
    db.prepare('INSERT INTO sends (code, service, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.code, service, r.ok ? 1 : 0, r.ok ? null : r.text.slice(0, 200), now());
  }
  if (!r.ok && OWNER_ID) {
    await push(OWNER_ID, `通知の送信に失敗しました。\nお店: ${row.shop_name}\nサービス: ${service}\n${r.text.slice(0, 150)}`);
  }
  return json(res, r.ok ? 200 : 502, { sent: r.ok, shop: row.shop_name });
}

// ── 運営API：宛先の登録・一覧 ─────────────────────────────
function handleRecipients(method, body, res) {
  if (method === 'GET') {
    const rows = db.prepare('SELECT code, shop_name, (line_user_id IS NOT NULL) AS linked, linked_at FROM recipients ORDER BY created_at').all();
    return json(res, 200, { recipients: rows });
  }
  const { code, shopName } = body || {};
  if (!code || !shopName) return json(res, 400, { error: 'code, shopName は必須です' });
  db.prepare('INSERT OR REPLACE INTO recipients (code, shop_name, created_at) VALUES (?, ?, COALESCE((SELECT created_at FROM recipients WHERE code = ?), ?))')
    .run(String(code).toUpperCase(), shopName, String(code).toUpperCase(), now());
  return json(res, 200, { ok: true, code: String(code).toUpperCase(), shopName });
}

// ── サーバー ──────────────────────────────────────────────
http
  .createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      const n = db.prepare('SELECT COUNT(*) c FROM recipients').get().c;
      const linked = db.prepare('SELECT COUNT(*) c FROM recipients WHERE line_user_id IS NOT NULL').get().c;
      return json(res, 200, { ok: true, recipients: n, linked });
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        // LINE Webhook
        if (req.method === 'POST' && req.url === `/webhook/${WEBHOOK_PATH}`) {
          if (!verifySignature(raw, req.headers['x-line-signature'])) {
            res.writeHead(401);
            return res.end('invalid signature');
          }
          res.writeHead(200);
          res.end('OK');
          const events = (JSON.parse(raw || '{}').events) || [];
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
        if (req.method === 'POST' && req.url === '/notify') return handleNotify(body, res);
        if (req.url === '/recipients') return handleRecipients(req.method, body, res);
        res.writeHead(404);
        res.end();
      } catch (e) {
        console.error('handler error', e.message);
        json(res, 500, { error: 'internal' });
      }
    });
  })
  .listen(PORT, () => console.log('しっとる通知ハブ 起動 port=' + PORT + ' db=' + DB_PATH));
