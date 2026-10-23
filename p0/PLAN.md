# P0 Doğrulama Planı

> Amaç (brief §9, §10): Electron'a yatırım yapmadan iki riski ucuza test etmek —
> (1) taşıma katmanı `--agent` + stream-json + `--resume` + MCP birlikte
> güvenilir mi, izinler yakalanıyor mu (teknik risk); (2) müzakere gerçekten
> karara varıyor mu (ürün riski).
> Araç: sade Node.js script'leri, `p0/` altında. Electron yok, UI yok.

## Ön bulgular (2026-07-08, CLI 2.1.169 + resmî dokümanlar)

Belgelerden ve yerel `--help`'ten doğrulandı:

- `--agent <isim>` ajanı oturumun **ana threadi** yapar (kendi system prompt,
  model, araç kısıtı); frontmatter alanları (`model`, `tools`,
  `permissionMode`, `mcpServers`) `--agent` ile geçerli. ✅
- Stream-json çok turlu: `-p --input-format stream-json --output-format
  stream-json` ile **tek süreç birden çok kullanıcı turu** işler; stdin açık
  kalır. Girdi şekli: `{"type":"user","message":{"role":"user","content":"..."}}`.
  İlk olay `system/init` (`session_id` taşır); tur sonu `result` olayı
  (`usage`, maliyet alanları). ✅
- `--resume <session_id>` stream-json ile belgeli ve uyumlu. ✅
- `--mcp-config` + `--strict-mcp-config` ile oturuma özel stdio MCP sunucusu. ✅
- Subagent kapatma: `--disallowedTools "Agent"`. ✅
- Bonus: `--session-id <uuid>` (kimliği doğumda biz atarız),
  `--replay-user-messages` (stdin mesajının stdout yankısı = teslimat teyidi).
- ⚠️ **KRİTİK BOŞLUK:** Ham CLI'nin `-p` modunda **belgeli bir izin
  callback'i YOK** — yalnızca ön-onay bayrakları (`--allowedTools`,
  `--permission-mode`). Belgeli tek programatik izin kancası **Agent SDK'nın
  `canUseTool` callback'i** (Bash, Write/Edit, MCP araçlarının tümünü kapsar).
  Agent SDK aynı `claude` CLI'yi saran resmî katmandır. → E3 karar noktası.

## Deneyler

### E1 — Tek oturum, çok turlu stream-json (~30 dk)
`claude --agent ping-agent -p --input-format stream-json --output-format
stream-json` başlat; iki ardışık kullanıcı mesajı gönder.
- **Geç:** init'te `session_id` geliyor; ikinci tur aynı süreçte işleniyor;
  `result` olayında usage var.
- **Kal → fallback:** İkinci tur aynı süreçte çalışmazsa her teslimat
  `--resume`'lu tek atış turn olur (belgeli, ama süreç-başına-oturum modeli
  değişir; brief §4.1 güncellenir).

### E2 — Kalıcılık: `--resume` (~15 dk)
Süreci öldür; `--resume <session_id>` ile yeni süreç; "az önce ne konuştuk?"
- **Geç:** Önceki bağlam hatırlanıyor; oturum kimliği davranışı (aynı ID mi,
  `--fork-session` gerekiyor mu) not edilir.

### E3 — İzin protokolü (~1-2 sa) — KARAR NOKTASI
İki kol, aynı senaryo: izin gerektiren üç araç türü tetiklenir (dosya Write,
`Bash`, MCP aracı).
- **Kol A (ham stream-json):** Ön-onaysız araç çağrısında akışta ne oluyor —
  izin olayı var mı, sessiz red mi, askı mı? (Belgesiz bir kanal bulunsa bile
  §3.6 gereği KULLANILMAZ; sadece davranış kaydedilir.)
- **Kol B (Agent SDK, TypeScript):** `canUseTool` üç araç türünü de yakalıyor
  mu; allow/deny çalışıyor mu; **abonelik kimlik doğrulamasıyla** (API
  anahtarsız, sıfır ek fatura) çalıştığı doğrulanır.
- **Karar kuralı:** Ham CLI'de belgeli izin kanalı yok + SDK abonelikle
  çalışıyor → taşıma katmanı Agent SDK üzerine kurulur (§3.6 tablosuna
  "İzinler: SDK `canUseTool`" işlenir; SDK zaten stream-json modunun resmî
  sarmalayıcısı, arka kapı değil). SDK abonelikle çalışmıyorsa → izin onay
  kartları P0'dan çıkar, v1 ön-onay allowlist'le gider; brief'e işlenir.

### E4 — MCP `send_message` ucu (~1 sa)
Minimal stdio MCP sunucusu (Node): `send_message(to, content)` +
`list_agents()`; oturuma `--mcp-config` + `--strict-mcp-config` ile verilir.
- **Geç:** Ajan aracı listeliyor ve çağırıyor; çağrı stream olaylarında
  görünüyor; sunucu çağrıyı orkestratör sürece iletiyor (Unix socket).

### E5 — İki ajanlı mesaj turu (~2 sa)
Node orkestratör: iki süreç (`ai-engineer`, `data-engineer`). Otobüs: A'nın
`send_message` çağrısı → B'nin stdin'ine `[ai-engineer'dan mesaj]: ...`
biçimli kullanıcı mesajı → B'nin cevabı aynı yolla A'ya.
- **Geç (brief §9 P0 ölçütü):** A'nın mesajı B'yi uyandırıyor, B cevap veriyor,
  tam tur kapanıyor; kullanıcı her iki ajanla da doğrudan konuşabiliyor;
  teslimat `--replay-user-messages` yankısıyla teyitli.
- **Ölçüm:** tur gecikmesi, mesaj başına token (kota maliyeti brief §10'a veri).

### E6 — Müzakere kalitesi (~2 sa) — ürün riski testi
İki ajanın `.md`'sine brief §5 takım protokolü (ÖNERİ/İTİRAZ/KABUL) eklenir;
çatışmalı soru: **"pgvector mı Pinecone mı?"** (gerçek çatışma için A'ya
pgvector'e, B'ye Pinecone'a eğilimli perspektif verilir).
- **Geç:** ≤8 mesajda `KABUL` ile biten karar + gerekçe; toplam token raporu.
- **Kal:** Nezaket ping-pong'u (argüman tekrarı, karar yok) → protokol prompt'u
  bir kez revize edilip tekrarlanır; ikinci başarısızlık ürün riskini YÜKSEK
  olarak brief'e işler (P2 tasarımı buna göre gözden geçirilir).

## Sıra, süre, çıktılar

Sıra: E1 → E2 → E3 (karar) → E4 → E5 → E6. Toplam ~1 iş günü.
E5/E6 abonelik kotası yakar — kota müsaitken koşulur.

Kullanıcının üç sorusuyla eşleme: (1) bileşenler birlikte çalışıyor mu =
E1+E2+E4; (2) izinler yakalanıyor mu = E3; (3) müzakere gerçek mi = E6.

Çıktılar:
- `p0/` altında deney script'leri (her deney ayrı, tek dosya, sade Node).
- `p0/BULGULAR.md` — her deney için geç/kal + ham olay örnekleri.
- Brief güncellemeleri: izin kanalı kararı (§3.6), transport notları (§4.1/§10).
