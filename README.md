# しっとる 通知ハブ

しっとるの全サービスから、お客様の公式LINEへ通知・レポートを送るための共通の口。

## なぜ必要か
各アプリが直接LINEのチャネルトークンを持つと、お客様が増えるたびに
アプリごと・お客様ごとの設定が必要になり、工数が積み上がる。
宛先の管理をここに寄せることで、各アプリは「どのご契約（code）へ」だけ知っていればよくなる。

## 使い方

宛先の登録（運営）
```
curl -X POST -H "Authorization: Bearer $NOTIFY_API_KEY" -H "Content-Type: application/json" \
  https://<host>/recipients -d '{"code":"SHOP-A1B2","shopName":"◯◯整体院"}'
```

お客様は「しっとる お知らせ」LINEを友だち追加し、コード（SHOP-A1B2）を送るだけで紐づく。

各サービスからの送信
```
curl -X POST -H "Authorization: Bearer $NOTIFY_API_KEY" -H "Content-Type: application/json" \
  https://<host>/notify -d '{"code":"SHOP-A1B2","service":"kuchikomi","text":"...","dedupeKey":"kuchikomi:2026-08"}'
```
`dedupeKey` を渡すと、同じものは二度送らない。

## 環境変数
| 変数 | 内容 |
|---|---|
| LINE_TOKEN | お知らせ用チャネルのアクセストークン |
| LINE_SECRET | 同 チャネルシークレット（署名検証） |
| WEBHOOK_PATH | Webhookの受け口パス（推測されない文字列） |
| NOTIFY_API_KEY | 各サービスが送信APIを叩くときの鍵 |
| OWNER_ID | 運営のuserId（登録・失敗の通知先） |
| DB_PATH | SQLiteの置き場所（既定 /app/data/hub.db） |

## 通数
プッシュはLINEの配信通数にカウントされる（あいさつ・応答メッセージはカウント外）。
月1回のレポートなら、フリープラン（月200通）で200社まで無料。
