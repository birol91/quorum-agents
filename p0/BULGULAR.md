# P0 Bulguları

> Koşum tarihi: 2026-07-08 · CLI 2.1.169 · Agent SDK 0.3.204 · Node 25
> Plan: [PLAN.md](PLAN.md) · Ham olay logları: `p0/logs/*.jsonl`
> Tüm koşular abonelik kimliğiyle (ANTHROPIC_API_KEY yok) — sıfır API faturası doğrulandı.

## Özet tablo

| Deney | Sonuç | Bir cümle |
|---|---|---|
| E1 çok turlu stream-json | ✅ GEÇTİ | Tek süreç iki turu işledi; `session_id` init'te, turlar arası bağlam korunuyor |
| E2 `--resume` | ✅ GEÇTİ | Yeni süreç ölü oturumu aynı `session_id` ile devraldı, bağlamı hatırladı |
| E3 izin protokolü | ✅ KARAR | Ham CLI'de izin callback'i YOK; **Agent SDK `canUseTool` seçildi** |
| E4 MCP `send_message` | ✅ GEÇTİ | In-process SDK MCP sunucusu; çağrı doğrudan otobüs fonksiyonuna düşüyor |
| E5 iki ajanlı tur | ✅ GEÇTİ | user→A→B→A→user tam tur 18.4 sn (haiku); kullanıcı B ile aynı oturumda doğrudan konuştu |
| E6 müzakere kalitesi | ✅ GEÇTİ | 4-5 mesajda gerekçeli karar + karşılıklı KABUL; ping-pong yok; eskalasyon protokolü kendiliğinden çalıştı |

## E1 — Çok turlu stream-json (`e1-multiturn.mjs`)

- `claude --agent ping-agent -p --input-format stream-json --output-format stream-json --verbose` tek süreçte iki ardışık kullanıcı turunu işledi; stdin açık kaldıkça süreç yaşıyor, `stdin.end()` ile temiz kapanıyor.
- `system/init` olayı `session_id` ve `model` taşıyor; her turun sonunda `result` olayı `usage` + `total_cost_usd` veriyor.
- Ajan frontmatter'ı (`model: haiku`) `--agent` ile uygulandı (init'te `claude-haiku-4-5` görüldü).
- 2. turda önbellek devrede (`cache_read=19484`) — kalıcı oturumun turlar arası maliyeti düşük.

## E2 — `--resume` kalıcılığı (`e2-resume.mjs`)

- E1'in süreci öldürüldükten sonra `--resume <session_id>` ile açılan YENİ süreç aynı `session_id`'yi korudu ve E1'de verilen bilgiyi (42) hatırladı.
- Sonuç: uygulama kapansa bile ajan kimliği + konuşma geçmişi resmî mekanizmayla geri geliyor (brief §4.1 doğrulandı).

## E3 — İzin protokolü: KARAR NOKTASI (`e3a-raw-permissions.mjs`, `e3b-sdk-permissions.mjs`)

**Kol A (ham stream-json):**
- Akışta hiçbir izin olayı YOK. Ön-onaysız `Write` çağrısı sessizce reddediliyor: `tool_result is_error=true`, metin: "Claude requested permissions … but you haven't granted it yet". Süreç askıda kalmıyor, tur normal bitiyor.
- Sürpriz: `echo done` gibi güvenli sayılan Bash komutları `--permission-mode default`'ta izinsiz ÇALIŞTI — varsayılan reddin CLI içi istisnaları var.
- Teyit: ham CLI'de programatik izin kanalı yok (dokümanla uyumlu).

**Kol B (Agent SDK `canUseTool`):**
- Callback üç araç sınıfının üçünü de yakaladı: `mcp__quorumtest__ping`, `Write`, `Bash`.
- `allow` → dosya yazıldı; `deny` → komut engellendi ve ajan ret mesajını gördü.
- API anahtarı olmadan (abonelik kimliği) sorunsuz çalıştı.

**KARAR (2026-07-08): Taşıma katmanı Agent SDK üzerine kurulur.** SDK, aynı
`claude` CLI'yi ve aynı stream-json protokolünü saran resmî, belgeli, versiyonlu
katmandır — arka kapı değildir (§3.6 tablosu güncellendi). Ham stream-json
belgeli yedek yol olarak kalır.

**Yan bulgular (ürün için önemli):**
- `allowedTools`'a yazılan araç `canUseTool`'a hiç düşmüyor (SDK uyarı basıyor). Quorum'da bilinçli kullanım: quorum araçları ön-onaylı, gerisi callback'e → izin kartı.
- Güvenli Bash istisnaları `canUseTool`'a da düşmeyebilir; izin kartı testlerinde `touch` gibi yazan komut kullan.
- SDK varsayılanında kullanıcı-seviyesi MCP sunucuları ve hook'lar çocuk oturuma sızıyor; izolasyon için `strictMcpConfig: true` şart, `settingSources` da bilinçli seçilmeli.

## E4 — In-process MCP `send_message` (`e4-mcp-endpoint.mjs`)

- `createSdkMcpServer` ile `send_message`/`list_agents` **orkestratör sürecin içinde** tanımlandı; ajanın çağrısı doğrudan otobüs fonksiyonuna düştü.
- **Mimari sadeleşme:** Otobüs için Unix socket köprüsüne gerek yok (brief §4.2 güncellendi). Gönderen kimliği closure'dan geliyor — içerikten/isimden çıkarım yok (§3.6 turnusolu geçer).
- `strictMcpConfig: true` sızıntıyı kesti: init'te yalnızca `quorum` sunucusu.

## E5 — İki ajanlı mesaj turu (`e5-roundtrip.mjs`)

- Tam tur: user→ai-engineer 7.7 sn → data-engineer 7.4 sn → cevap → özet→user 3.3 sn; **toplam 18.4 sn** (haiku).
- Meşgulken teslimat: basit boşta/meşgul durum makinesi + bekleyen kuyruğu (P1'in prototipi) sorunsuz.
- Kullanıcı, ajan-ajan trafiğin ortasında data-engineer'a doğrudan yazdı; aynı canlı oturum cevap verdi ("PONG").
- Token: ajan başına 2 turda ~46 girdi + ~700-830 çıktı token'ı (+ önbellek okumaları).
- Pürüz 1: İlk koşu 5 dk'da hiç olay üretmeden zaman aşımına uğradı (tekrarında anında çalıştı). Kök neden bulunamadı; şüpheli, çocuk oturuma sızan kullanıcı-seviyesi SessionStart hook'ları. Ürün için: `settingSources` kısıtla + oturum başlatmaya sağlık zaman aşımı koy.
- Pürüz 2: Kapanışta girdi kuyruğunu tur biterken kapatmak "permission stream closed" hatası üretebiliyor — üründe önce drenaj, sonra kapanış (P1).

## E6 — Müzakere kalitesi (`e6-negotiation.mjs`)

Zıt eğilimli personalar (ai-engineer→Pinecone, data-engineer→pgvector), sonnet,
ÖNERİ/İTİRAZ/KABUL protokolü, 12 ajan-ajan mesaj tavanı. İki koşu:

**Koşu 1 (`logs/e6-run.log`):** 5 mesajda taraflar konuyu gerçek bir bilgi
boşluğuna indirgedi (yazma deseni) ve karar vermek yerine brief §5'in
eskalasyon kuralını uygulayıp kullanıcıya sordu. Script bunu öngörmediği için
"FAIL" saydı — ama davranış protokolün tam istediği şeydi. Ders: **"kullanıcıya
mesaj" ≠ "nihai karar"; toplantı odası UI'ı ajan sorularını ayrı ele almalı.**

**Koşu 2 (eskalasyon cevaplı, `logs/e6-run2.log`): GEÇTİ.**
- 4 ajan-ajan mesajı + karşılıklı KABUL + kullanıcıya gerekçeli nihai karar; 121 sn.
- Karar: pgvector (dedicated instance). Gerekçe zinciri gerçek mühendislik:
  yazma hızı hesabı (~0.76 embedding/sn ort.), pg16 artımlı HNSW (rebuild
  korkusunu çürüttü), ops/vendor toil karşılaştırması, maliyet.
- **Nezaket ping-pong'u YOK:** başta Pinecone savunan ajan, argüman karşısında
  gerekçeli teslim oldu ve fikir değişimini kullanıcıya raporladı.
- Maliyet: toplam ~10.6k çıktı token (A: 7.4k, B: 3.2k) + ~9.7k girdi; brief
  §12'deki "müzakere, tek turn sentezin 5-10 katı token yakar" tahmini doğru
  yönde ama kabul edilebilir düzeyde.

**Ürün riski sonucu: müzakere kalitesi GERÇEK.** P2'nin karar katmanı bu
protokolle kurulabilir. İki tasarım girdisi: (1) eskalasyon birinci sınıf akış
olmalı (soru kartı → kullanıcı cevabı → müzakere devam); (2) KABUL tespiti
UI/mekanizma için etiket ayrıştırmasına değil `record_decision` çağrısına
bağlanmalı (P2'de zaten plan bu).
