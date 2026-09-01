'use strict';

/**
 * 初期ヒアリング（サロンカルテ導入時の設定入力）
 *
 * なぜ作るか:
 *   予約システムをご契約いただくたびに、三上様とクライアントで
 *   「店舗は何店舗か」「メニューと料金は」「営業時間は」「スタッフは誰が何を担当するか」
 *   といった打ち合わせが必要になる。1件あたり1時間として、10件で10時間。
 *   月19,800円の商品でこれを続けると、受注が増えるほど苦しくなる。
 *   その打ち合わせをなくすため、クライアント自身にLINEから入力していただく。
 *
 * なぜ専用の公式LINEを作らないか:
 *   院長は月次レポートを受け取るために、どのみち「しっとる 実績レポート」と
 *   連携する。その流れで初期設定まで済ませられるので、LINEを増やす理由がない。
 *   公式アカウントを1つ増やすと、お客様ごとの設定作業が倍になる。
 *
 * なぜLIFFを使わないか:
 *   連携コードで誰の入力かが分かるため。LIFFを足すとLINE Developersでの
 *   登録が要るうえ、ログインの手間が増える。コード入りのURLで十分。
 *
 * 途中保存:
 *   入力項目が多いので、一度で終わらない前提にしている。
 *   「途中まで保存」を押せば、同じURLを開き直すと続きから書ける。
 */

const SECTIONS = [
  {
    key: 'basic',
    title: 'ご担当者とご連絡先',
    note: '設定でご不明な点があったときの連絡先です。',
    fields: [
      { k: 'clinic_name', l: '院・会社の正式名称', ph: '例）医療法人さくら会 さくら整骨院', req: true },
      { k: 'owner_name', l: 'ご担当者のお名前', ph: '例）山田 太郎', req: true },
      { k: 'owner_tel', l: 'お電話番号', ph: '例）086-000-0000', req: true },
      { k: 'owner_email', l: 'メールアドレス', ph: '例）info@example.com', req: true },
    ],
  },
  {
    key: 'stores',
    title: '店舗',
    note: '店舗ごとに1行ずつご記入ください。1店舗だけなら1行で結構です。',
    repeat: 3,
    repeatLabel: '店舗',
    fields: [
      { k: 'name', l: '店舗名', ph: '例）本院 / 駅前店' },
      { k: 'address', l: '住所', ph: '例）岡山県◯◯市◯◯1-2-3' },
      { k: 'tel', l: '電話番号', ph: '例）086-000-0000' },
      { k: 'hours', l: '営業時間', ph: '例）9:00〜19:00（土は9:00〜15:00）' },
      { k: 'closed', l: '定休日', ph: '例）日曜・祝日' },
    ],
  },
  {
    key: 'menus',
    title: 'メニューと料金',
    note: 'よく出るものから、上位6つまでご記入ください。残りは後からいくらでも足せます。',
    repeat: 6,
    repeatLabel: 'メニュー',
    fields: [
      { k: 'name', l: 'メニュー名', ph: '例）整体（60分）' },
      { k: 'price', l: '料金（税込）', ph: '例）6,600' },
      { k: 'minutes', l: '所要時間（分）', ph: '例）60' },
      { k: 'category', l: '分類', ph: '例）整体 / 鍼灸 / ピラティス' },
    ],
  },
  {
    key: 'staff',
    title: 'スタッフ',
    note: '施術を担当される方をご記入ください。担当できるメニューが分かれている場合は、その旨も。',
    repeat: 6,
    repeatLabel: 'スタッフ',
    fields: [
      { k: 'name', l: 'お名前', ph: '例）山田 太郎' },
      { k: 'menus', l: '担当できるメニュー', ph: '例）整体のみ / すべて' },
      { k: 'days', l: '出勤される曜日', ph: '例）月火水金土' },
    ],
  },
  {
    key: 'rules',
    title: 'ご予約のルール',
    note: '迷われたら空欄で構いません。よくある設定で始めて、後から変えられます。',
    fields: [
      { k: 'ahead_days', l: '何日先まで予約を受けるか', ph: '例）30日' },
      { k: 'cutoff', l: '何時間前まで受け付けるか', ph: '例）2時間前まで' },
      { k: 'buffer', l: '施術の前後にとる余裕時間', ph: '例）前後15分' },
      { k: 'cancel', l: 'キャンセルの扱い', ph: '例）前日までは無料' },
    ],
  },
];

const FEATURES = [
  ['prepayment', '前金（初めての方に事前のお支払いをご案内）'],
  ['tickets', '回数券'],
  ['staff_nomination', '担当者のご指名'],
  ['group_lessons', 'グループレッスン'],
  ['home_visit', '往診（訪問しての施術）'],
  ['line_talk_booking', 'LINEのトーク内でのご予約'],
  ['review_request', '口コミ依頼の自動送信'],
  ['counseling', '初診時のカウンセリングシート'],
];

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setups (
      code         TEXT PRIMARY KEY,
      data         TEXT NOT NULL DEFAULT '{}',
      submitted_at INTEGER,
      updated_at   INTEGER NOT NULL
    );
  `);
}

const load = (db, code) => {
  const r = db.prepare('SELECT * FROM setups WHERE code = ?').get(code);
  if (!r) return { data: {}, submitted_at: null };
  try { return { data: JSON.parse(r.data || '{}'), submitted_at: r.submitted_at }; }
  catch { return { data: {}, submitted_at: r.submitted_at }; }
};

const save = (db, code, data, submitted) => {
  db.prepare(
    `INSERT INTO setups (code, data, submitted_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET data = excluded.data,
       submitted_at = COALESCE(excluded.submitted_at, setups.submitted_at),
       updated_at = excluded.updated_at`
  ).run(code, JSON.stringify(data), submitted ? Date.now() : null, Date.now());
};

/** 入力された内容を、三上様が読める1通のテキストにする */
function summarize(shopName, data) {
  const v = (k) => String(data[k] ?? '').trim();
  const out = [`${shopName} 様から初期設定のご入力がありました。`, ''];
  for (const s of SECTIONS) {
    const lines = [];
    if (s.repeat) {
      for (let i = 1; i <= s.repeat; i++) {
        const parts = s.fields.map((f) => v(`${s.key}_${i}_${f.k}`)).filter(Boolean);
        if (parts.length) lines.push(`${i}. ` + s.fields.map((f) => {
          const val = v(`${s.key}_${i}_${f.k}`);
          return val ? `${f.l}=${val}` : null;
        }).filter(Boolean).join(' / '));
      }
    } else {
      for (const f of s.fields) { const val = v(`${s.key}_${f.k}`); if (val) lines.push(`${f.l}：${val}`); }
    }
    if (lines.length) { out.push(`【${s.title}】`, ...lines, ''); }
  }
  const on = FEATURES.filter(([k]) => data['feature_' + k]).map(([, l]) => l);
  out.push('【お使いになる機能】');
  out.push(on.length ? on.map((l) => '・' + l).join('\n') : '（選択なし）');
  const free = v('free_note');
  if (free) { out.push('', '【ご要望・特記事項】', free); }
  return out.join('\n');
}

module.exports = { SECTIONS, FEATURES, ensureTable, load, save, summarize };
