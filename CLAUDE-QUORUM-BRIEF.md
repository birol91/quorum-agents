# Quorum — Proje Brief'i

> **Durum:** P0–P5 çekirdeği çalışıyor ve canlı doğrulandı (2026-07-09). Bu
> doküman tasarım referansıdır; gerçekleşme notları ilgili bölümlere işlendi.
> **Tarih:** 2026-07-08 (tasarım) · 2026-07-09 (gerçekleşme denetimi)
> **Kaynak:** AgentBoard oturumlarındaki tasarım tartışması

---

## 1. Problem: Subagent modelinin sınırları

Bugün AgentBoard, Claude Code'un **subagent** özelliğini görselleştiriyor. Bu modelde:

- Tek bir Claude Code oturumu (orkestratör) vardır; kullanıcı **yalnızca onunla** konuşur.
- Subagent'lar orkestratörün çocuk süreçleridir: işi yapar, sonucu döndürür, kapanır.
- Subagent'lar **birbirleriyle ve kullanıcıyla konuşamaz** — bu yapısal bir kısıttır.
- Bloğun hangi ajana ait olduğu, Claude'un `subagent_type` seçiminden **çıkarım** yapılarak
  bulunur. Claude isimsiz (`general-purpose`) ajan başlatırsa blok yeşil yanmaz.
  (Geçici çözüm: `enforce-named-agents` PreToolUse hook'u — ama bu semptom tedavisidir.)

## 2. Vizyon

Her ajan **kendi bağımsız Claude Code oturumu** olsun:

- Kullanıcı **istediği ajanla doğrudan** konuşur (bloğa tıkla, terminale yaz).
- Ajanlar **birbirleriyle mesajlaşır**: soru sorar, iş böler, müzakere eder.
- Ajanlar **kendi kararlarını alır**: öneri → itiraz → kabul protokolüyle tartışıp
  karara varır, kararı kalıcı kayda geçirir.
- Canvas her şeyi canlı gösterir: aktif oturumlar, mesaj trafiği (oklar), kararlar.

## 3. Temel ilkeler

1. **API yok, abonelik yeter.** Tüm oturumlar `claude` CLI ile kullanıcının
   Pro/Max planında çalışır. Anthropic API'ye tek satır istek atılmaz; ek fatura yoktur.
   Tek maliyet: N paralel oturum plan kotasını N kat hızlı tüketir.
2. **Yalnızca kararlı (GA) ve BELGELİ yapı taşları.** `claude --agent`, MCP,
   hook'lar ve CLI'ın resmî programatik modu (stream-json giriş/çıkış +
   `--resume`). Deneysel *agent teams* özelliğine sıfır bağımlılık (bkz. §8).
   **PTY/TUI otomasyonu KULLANILMAZ** — terminale programatik metin yazmak
   (prompt enjeksiyonu) belgelenmemiş bir yüzeydir; karar 2026-07-08: tamamen
   kaldırıldı, taşıma katmanı yalnızca stream-json.
3. **Uygulama LLM'e vekillik etmez** (AgentBoard ilkesinin devamı). Quorum mesajı
   *taşır* ve *görselleştirir*; içerik üretmez, model çağrısı yapmaz.
4. **Kritik kurallar prompt'a değil, mekanizmaya.** Tur bütçesi, kuyruklama,
   teslimat garantileri uygulama katmanında; modelin "unutması" mümkün değil.
5. **Değiştirilebilir mesaj arka ucu.** Kalıcı yatırım görselleştirme + oturum
   yönetimi katmanıdır. Mesaj taşıma ince bir katmandır; Anthropic'in agent teams'i
   GA olursa arka uç ona çevrilebilir, canvas ve UX aynen kalır.
6. **ARKA KAPI YASAĞI (pazarlıksız — AgentBoard dersi).** AgentBoard, sahibi
   olmadığı oturumları dışarıdan tahminle izliyordu (transcript yoklama, isim
   parmak izi, hook payload çıkarımı) ve "yeşil yanmıyor" bug'larının tamamı bu
   tahmin katmanından çıktı. Quorum'da kural: **her entegrasyon noktası belgeli
   bir arayüz olmak zorunda; durum bilgisi asla çıkarım olamaz.**

   İzinli entegrasyon noktaları (hepsi belgeli):

   | Nokta                          | Arayüz                                                                                                                                                              |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Oturum başlatma               | `claude --agent <isim>` (belgeli CLI bayrağı)                                                                                                                    |
   | Mesaj giriş/çıkış         | stream-json programatik mod (belgeli, versiyonlu)                                                                                                                    |
   | Oturum kimliği                | Akışın init olayındaki`session_id` (belgeli alan)                                                                                                              |
   | Kalıcılık                   | `--resume` (belgeli)                                                                                                                                               |
   | Ajan araçları                | MCP (belgeli protokol)                                                                                                                                               |
   | İzinler                       | Agent SDK`canUseTool` callback'i (belgeli; P0 kararı 2026-07-08)                                                                                                  |
   | Oturum çalıştırma katmanı | Agent SDK`query()` — aynı `claude` CLI'yi ve stream-json protokolünü saran resmî, belgeli katman (P0 kararı 2026-07-08; ham stream-json belgeli yedek yol) |

   Yasaklılar: PTY/TUI otomasyonu, transcript dosyası yoklama, isim/açıklama
   parmak izi eşleştirme, makine-geneli olay dinleyip cwd ile filtreleme
   (oturumları biz doğurduğumuz için hangi akış kime ait zaten kesin), ve
   **doğruluğu hook olaylarına bağlı hiçbir özellik** — hook sunucusu yalnızca
   ikincil telemetri/görselleştirme süsü olabilir, hiçbir durum kararının tek
   kaynağı olamaz. Kaynak gerçek: sürecin kendi olay akışı + süreç yaşam döngüsü.

   Turnusol: "Bu bilgiyi nereden biliyoruz?" sorusunun cevabı bir tahmin,
   yoklama veya eşleştirme içeriyorsa, o tasarım reddedilir.

## 4. Mimari

```
┌─────────────────── Quorum (Electron main) ────────────────────────┐
│                                                                    │
│  Oturum Yöneticisi         Mesaj Otobüsü          Hook Sunucusu    │
│  blok başına bir           kuyruk + yönlendirme   (AgentBoard'dan  │
│  `claude --agent <isim>`   + tur bütçesi          devralınır)      │
│  stream-json modunda             │                     │           │
└────────┬──────────┬──────────────┼─────────────────────┼───────────┘
         │          │              │                     │
    ┌────▼───┐ ┌────▼───┐   MCP: send_message      Stop/SubagentStop
    │oturum A│ │oturum B│   list_agents            olayları →
    │ai-eng. │ │data-eng│   record_decision        meşgul/boşta takibi
    └────▲───┘ └────▲───┘
         │          │
    kullanıcı Quorum'un sohbet arayüzünden yazar
    (mesaj balonları, araç çağrısı kartları, izin onay kartları)
```

### 4.1 Oturum Yöneticisi

- Canvas'taki her ajan bloğu = `claude --agent <isim>` süreci, **CLI'ın resmî
  programatik modunda** (stream-json giriş/çıkış). PTY/terminal otomasyonu YOK.
- Mesajlar sürece yapılandırılmış JSON olarak yazılır, cevaplar olay akışı
  olarak okunur (asistan mesajları, araç çağrıları, turn sonu) — belgeli,
  versiyonlu protokol.
- `--agent` sayesinde oturumun **ana threadi** o ajandır (kendi system prompt'u,
  modeli, araç kısıtları) — subagent değil, ajanın kendisi.
- Blok ↔ oturum eşlemesi doğum anında bellidir (`session_id` akışın ilk
  olayında gelir). **"Yeşil yanmama" problemi yapısal olarak ortadan kalkar.**
- Oturum sürekliliği resmî `--resume` mekanizmasıyla: uygulama kapansa bile
  ajanın konuşma geçmişi korunur ve kaldığı yerden devam eder.
- **İzin istekleri** programatik modun izin protokolüyle yakalanır ve Quorum
  arayüzünde onay kartı olarak gösterilir (ham terminal prompt'u yerine).

### 4.2 Mesaj Otobüsü (ana süreçte)

- **Gönderme:** Ajan, MCP aracı `send_message(to, content)` çağırır → mesaj ana
  sürece düşer. *(P0 kararı 2026-07-08: MCP sunucusu `createSdkMcpServer` ile
  ana sürecin İÇİNDE koşar — çağrı doğrudan otobüs fonksiyonuna gelir, Unix
  socket köprüsü gerekmez. Gönderen kimliği oturum başına sunucu örneğinin
  closure'ından gelir; çıkarım yok.)*
- **Teslimat = stream-json girdisi.** Claude Code oturumu turn-tabanlıdır;
  boştayken hiçbir şey yapamaz, poll edemez. Otobüs, mesajı hedef oturumun
  stdin'ine `[data-engineer'dan mesaj]: ...` içerikli bir kullanıcı mesajı
  JSON'u olarak yazar; oturum uyanır, cevap verir. (Terminale tuş basma taklidi
  değil — sürecin resmî girdi kanalı.)
- **Meşguliyet kuyruklama:** Turn yaşam döngüsü stream'in kendi olaylarından
  izlenir (turn sonu olayı = boşta); hook sunucusu ikincil doğrulama kaynağı.
  Hedef meşgulken mesajlar kuyrukta bekler, boşa düşünce teslim edilir.
  *(P1 2026-07-08: `src/bus.ts` + `src/session.ts` olarak gerçeklendi — FIFO
  kuyruk, tur bütçesi notu, §14 yönlendirme kuralları; birim testli
  (`test/bus.test.ts`) + canlı smoke'lu (`p1/`). Bkz. `p1/BULGULAR.md`.)*
- **Kullanıcıya mesaj:** `send_message("user", ...)` → UI bildirimi/paneli.
- **Kullanıcı arayüzü:** Ham terminal yerine Quorum kendi sohbet görünümünü
  çizer — mesaj balonları, araç çağrısı kartları, izin onayları. (AgentBoard'ın
  xterm bileşeni Quorum'da kullanılmaz; "ham akışı gör" istenirse stream-json
  olay günlüğü ayrı bir debug panelinde gösterilebilir.)

### 4.3 MCP Araçları (proje `.mcp.json`'ına Quorum kurar)

| Araç                                           | İş                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `send_message(to, content)`                   | Ajana veya`"user"`a mesaj gönder               |
| `list_agents()`                               | Takımdaki ajanları ve uzmanlıklarını listele |
| `record_decision(topic, decision, rationale)` | Kararı`decisions.md`'ye ve UI'a kalıcı yaz   |
| (v2)`claim_task` / `complete_task`          | Paylaşımlı görev panosu — çift iş önleme  |

## 5. Karar protokolü

İş bölümü ve kararlar koda değil **prompt'lara** yazılır; Quorum her ajanın `.md`
tanımına standart bir "takım protokolü" bölümü ekler:

- **Mesaj etiketleri:** Tartışırken mesajını etiketle: `ÖNERİ:`, `İTİRAZ:`, `KABUL:`.
- **Karar kuralı:** Tüm taraflar `KABUL` dediğinde karar alınmıştır; kazanan taraf
  `record_decision` çağırır. Karardan sonra tartışma yeniden açılmaz.
- **Oylama:** 3+ ajan uzlaşamazsa oylama (tek sayıda katılımcı — berabere kalmaz).
  *(Durum 2026-07-09: HENÜZ YAPILMADI — sadece ikili ÖNERİ/İTİRAZ/KABUL var; oylama
  mekanizması ertelendi, README roadmap "next" listesinde.)*
- **Eskalasyon:** Geri döndürülmesi zor işlerde (silme, deploy, mimari değişiklik)
  karar alma → `send_message("user", ...)` ile kullanıcıya sor.
- **Cevap yükümlülüğü:** Mesaj gelirse işi yap ve gönderene dön; başka uzmanın
  bilgisi gerekiyorsa ona **doğrudan** sor, koordinatörü bekleme.

**Mekanizma sigortaları** (uygulama katmanında, garantili):

- **Tur bütçesi:** Aynı ikili arasındaki zincir N mesajı (örn. 8) aşarsa otobüs
  araya not enjekte eder: *"Karara bağlayın ya da kullanıcıya taşıyın."*
- Karar kayıtları dosyada kalıcıdır; sonraki oturumlar okur.

*(P2 2026-07-08: gerçeklendi — `record_decision` aracı `src/tools.ts`'te,
kalıcı depo `src/decisions.ts`'te (`decisions.jsonl` gerçek kaynak +
`decisions.md` render); kazanan-taraf-kaydeder kuralı protokolde. Çatışmalı
soru testi kalıcı kayıtla geçti; bkz. `p2/BULGULAR.md`.)*

## 6. İşbirliği desenleri

- **Delegasyon:** Kullanıcı işi bir koordinatör bloğa verir; koordinatör
  `list_agents` + `send_message` ile böler, sonuçları toplar, raporlar.
- **Yarışma + çapraz inceleme:** İki ajan aynı görevi bağımsız yapar, sonuçları
  değiş tokuş edip eleştirir, protokolle iyisini (veya birleşimini) seçer.
- **Öneren + eleştiren:** Biri çözer, diğerinin tek görevi kusur bulmaktır;
  öneren ikna edene veya düzeltene kadar döngü sürer.
- **Serbest müzakere:** Kullanıcı bir soruyu gruba atar; ajanlar kendi aralarında
  tartışıp `record_decision` ile sonuçlandırır.

## 7. Kullanıcı deneyimi

*(Gerçekleşme durumu 2026-07-09 kod denetimi ile işaretlendi.)*

- ~~Bloğa tıkla → o ajanın **ayrı sohbet penceresi**~~ → **DEĞİŞTİ:** ayrı per-agent
  pencere yerine tek **toplantı odası** + @mention + canvas çoklu seçim yapıldı
  (işlevsel eşdeğer: istediğin ajanla doğrudan konuşursun). Bloğa çift tık →
  model/izin ayar penceresi. Ayrı sohbet penceresi UI'ı ertelendi.
- ✅ Mesaj trafiği canvas'ta ok animasyonlarıyla akar; thread'e tıklanabilir.
- ✅ "Kararlar" paneli gerekçeleriyle; temizlenebilir (Clear). *(2026-07-16:
  panel UI'dan kaldırıldı — kullanıcı kararı. Karar katmanı mekanizma olarak
  yaşıyor: `record_decision` + `decisions.jsonl`/`decisions.md` disk kaydı;
  yalnız görüntüleme yüzeyi söküldü, istenirse geri eklenebilir.)*
- ✅ Aktif/durum çıkarım değil süreç bilgisi.
- ✅ (ek) Marketplace, model/izin başına ayar, çoklu seçim, @everyone, clear layout.
- ✅ (2026-07-16) Marketplace 3. kaynak: **anthropics/financial-services**
  (resmî, 33.5k★) — 10 finans ajanı (`earnings-reviewer`, `kyc-screener`,
  `statement-auditor`…), `scripts/import-financial-services.mjs` ile içe
  alındı; toplam 379 ajan. Not: ajan gövdeleri FactSet/Daloopa gibi vendor
  MCP araçlarına atıf yapar — Quorum'da araç erişimi izin broker'ından geçer,
  o araçlar yoksa ajan genel yetenekleriyle çalışır.
- ✅ (2026-07-18) **Splash + Welcome ekranı:** açılışta 1.8 sn marka splash'i
  (ızgara zemin + elmas + cyan→mor degrade QUORUM; `pointer-events: none` —
  script'leri/tıklamaları asla bloklamaz; pencere-içi reload'da tekrarlamaz).
  Düz açılış artık son projeyi otomatik açmak yerine **karşılama ekranına**
  düşer: "Open project…" + tıklanabilir **Recent projects** listesi (son 8,
  var olmayan dizinler süzülür, `settings.json.recentProjects`).
  `QUORUM_PROJECT` env'i (script'ler) welcome'ı atlar. Canlı doğrulandı:
  recents'ten Breaktor tek tıkla açıldı.
- ✅ (2026-10-21, v2.3) **Takım varsayılanları ölçüme göre değişti + insan
  işareti composer trafiğinin HEDEFİ oldu + terminal etiketi düzeldi.**
  Varsayılanlar artık `sonnet` / `medium` / `both` (team.ts şeması, manager'ın
  üç düşüş noktası, session.ts son çaresi): haiku'nun sessiz turları (tur
  `send_message`siz biter, hiçbir şey teslim edilmez) daha yavaş turlardan
  pahalıya mal oluyor; effort haiku'da ölçülen şekilde etkisiz ama sonnet'te
  gerçek, medium çalışma ayarı; `both` çünkü izin sorusu bütün takımı bir insan
  fark edene kadar durduruyor — marketplace eklemeleri de artık `both`/`medium`.
  Canvas: composer trafiği artık Team Lead bloğuna DEĞİL, lead bloğunun altında
  beliren insan işaretine akıyor (uçuş boyunca görünür, mesajla birlikte söner);
  `edgeOfCircle` yardımcısı yuvarlak düğümün kenarını veriyor. Terminal
  etiketi `store.ts`'te yalnız `from` tarafında "you" diyordu, `to` tarafı hep
  "Team Lead"di — oda satırıyla aynı hata; etiket mantığı `userChannelName`
  olarak `shared/ipc.ts`'e taşındı (tek kaynak, test edilebilir) ve iki taraf da
  oradan okuyor. 50 test.
- ✅ (2026-10-21, v2.2) **Composer cevapları artık "Team Lead"e değil SANA
  dönüyor (etiket + animasyon):** Uygulama içi lead yokken composer trafiği
  lead'e hiç uğramaz (bus doğrudan kullanıcıya teslim eder), ama oda satırı
  alıcıyı her zaman "Team Lead" yazıyordu ve canvas oku Team Lead bloğuna
  gidiyordu — kullanıcıya gittiği yer hakkında yanlış bilgi veriyordu. Bus artık
  soruyu HANGİ kanalın sorduğunu hatırlıyor (`userChannel`) ve kullanıcıya giden
  cevabı o kaynakla damgalıyor; oda satırı composer trafiğinde "→ you" yazıyor,
  ajan etiketi "replying to you…" oluyor. Canvas: lead bloğu hâlâ kullanıcı
  kanalının çapası olduğu için ok oraya iner, fakat composer trafiğinde yayın
  anında (soru) ve varış anında (cevap) kısa bir İNSAN SİLUETİ belirip soluyor —
  lead bir aktarıcıymış gibi görünmüyor. Regresyon testleri: composer cevabı
  `via: 'composer'`, köprü cevabı `via: 'bridge'` taşır.
- ✅ (2026-09-24, v2.1) **Kuyruk birleştirme — posta artık tur maliyeti değil:**
  `flush()` her `idle` olayında kuyruktan TEK mesaj alıyordu, yani bir ajan
  çalışırken gelen her mesaj ayrı bir tur demekti. İki takım arkadaşı taslak
  gönderdiyse ajanın ikisini okuması 2 değil 4 tur sürüyordu ve maliyet takım
  büyüdükçe artıyordu (4 arkadaş → 4 tur). Kuyruk artık tek turda devredilir;
  mesajlar ayrı ve etiketli kalır (`--- message 1 of 3 ---`) — ajan kimin ne
  dediğini görmeye devam eder, yalnız gidiş-dönüşler birleşir. Sıra korunur,
  hiçbir mesaj düşmez, tek mesaj eskisi gibi sarmalanmadan gider. Gerçek `Bus`
  üzerinde ölçüldü: 2/3/4 bekleyen taslak → hepsi 1 tur. Canlı doğrulama: iki
  ajanlı grup görevi, iki cevap da teslim, sessiz tur yok.
- ✅ (2026-09-23) **Hız: quorum araçları artık ertelenmiyor + çapraz danışma
  doğru tetikleniyor.** Ajanlar 37 araçla koşuyor (29 yerleşik `settingSources:
  []`'e rağmen hayatta — o seçenek ayar yüklemeyi yönetir, araç yüzeyini değil),
  yani araç araması açık ve quorum araçları onun arkasına erteleniyordu:
  `send_message` çağrılmadan önce aranmak zorundaydı. Üretim seçenekleriyle
  ölçülen A/B (haiku, effort=high): ToolSearch 1→0, 6058/5422 ms → 4626/3730 ms.
  `createSdkMcpServer({ alwaysLoad: true })` (SDK `defer_loading: false`) tek
  seçenekle çözüyor. Bu sadece gecikme değil bir hata modunu da kaldırıyor:
  `send_message` bir turun işinin oturumdan çıkmasının TEK yolu, ve aramayı
  beceremeyen tur sessiz biter. Aynı gün ölçüldü: belirsiz ifade ("reply to user
  with send_message") 180 sn bekleyip hiç cevap vermedi, aracı adıyla söyleyince
  4 sn; `alwaysLoad` sonrası aynı belirsiz ifade 3,0 sn ve `silent: []`.
  Ayrıca `wantsConsult` regex'i alt-dize eşliyordu (`danış`→"danışman",
  çıplak `birbir`→"birbirine bağla"); yanlış tetikleme pahalı — zorunlu çapraz
  danışma 2 turluk grup görevini ~6 tura çıkarır (her ajan cevaptan önce taslak
  takas etmek zorunda). Türkçe fiil çekimleri açıkça, İngilizce terimler
  tam-kelime eşleniyor. ÖLÇÜLDÜ ve DEĞİŞTİRİLMEDİ: haiku'da effort farkı yok
  (high/medium/low ~4,2-4,8 sn, ayrışma yok — `supportsEffort`), sarmalayıcı
  metinler ihmal edilebilir (grup 355 kr, lead brief 451/815 kr), sistem
  prompt'u prompt-cache'leniyor (`cache_read` 36,7k, `cache_creation` ~220).
- ✅ (2026-09-23) **İki mesaj-kaybı hatası (oturum devri):** `updateAgent`
  model/effort değişiminde eski oturumu kapatıp yenisini doğuruyor, ama eski
  oturum bus dinleyicisini koruyordu. Son turu `close()` beklenirken biter —
  yeni oturum kaydolmadan ÖNCE — ve dinleyici `flush()` çalıştırıp kuyruğu
  emekliye ayrılan sürece yazıyordu: mesaj yeni oturuma ulaşmıyor, üstüne
  `write()` eski oturumu tekrar `busy` yaptığı için `close()` asılı kalıyordu.
  `Bus.unregister()` eklendi (manager `updateAgent` ve `removeAgent`'ta
  `close()` ÖNCESİ çağırır); kuyruk bilinçli olarak KORUNUR — bekleyen posta
  sürecin değil ajanın malıdır — ve `register()` devralınan kuyruğu flush eder
  (aksi halde `flush` yalnız `idle` olayıyla çalışır, taze oturum ise tur
  almadan olay yaymaz). Ayrıca `removeRosterEntry` `awaitingReply`'ı temizlerken
  `nudged`'ı bırakıyordu: aynı isimle yeniden eklenen ajan öncekinin harcanmış
  dürtüsünü miras alıyor, ilk sessiz turu ne dürtülüyor ne raporlanıyordu.
  İkisi de düzeltmeden önce gerçek `Bus` üzerinde tekrar üretildi, sonra
  doğrulandı; regresyon testleri var.
- ✅ (2026-09-23) **Sessiz tur artık raporlanıyor:** `send_message` çağırmadan
  biten bir tur hiç bus mesajı üretmez — ajan cevap verdiğini sanır (düz metin
  yazmıştır) ama hiçbir şey oturumdan çıkmaz. Eskiden tek iz konsol satırıydı;
  `replies()` `{replies: [], busy: []}` döndüğü için bekleyen taraf kaybolmuş
  cevabı hiç sorulmamış ajandan ayırt edemiyordu (ölçüldü: gelmeyecek bir cevap
  için 180 sn bekleme). Bus zaten tespit ediyordu (bir kez dürtüyor); artık
  bildiriyor da: `Bus.onSilentTurn` → manager (UI etiketi) → köprü, ve
  `replies()` cevabına `silent` dizisi eklendi — inbox gibi drain edilir (her
  rapor tam bir kez teslim) ve bekleyen long-poll'u erken uyandırır. Ayrıca
  stub bırakılmış `trace`/`onDrop` bağlandı ve `error_*` ile biten turlar
  loglanıyor (önceden temiz bitişten ayırt edilemiyordu). 40 birim testi +
  canlı doğrulama.
- ✅ (2026-07-18, v1.6) **Cevap hakları birikir (kritik bugfix):** teslimat
  politikası "son giriş"e sıfırlanıyordu — lead ardışık iki hedefli `ask`
  attığında ikincisi birincinin cevap hakkını siliyor, ilk ajanın cevabı
  sessizce bounce ediliyordu (canlıda yaşandı: ev-systems-specialist idle +
  boş kutu). `setDeliveryPolicy` artık hakları EKLER (grup 1+1, direct ∞);
  hiçbir dağıtım öncekini iptal edemez. Ek: `replies()` cevabına `busy`
  listesi (boş dönüş "hâlâ çalışıyor" mu ayrımı) ve oda etiketleri köken-
  doğru — köprü trafiği "Team Lead", composer "you", ajan cevapları
  "→ Team Lead" (`BusMessage.via`, salt gösterim). Regresyon birim testi +
  canlı e2e: ardışık iki hedefli ask → iki cevap da teslim.
- ✅ (2026-07-17, v1.5) **Aktivite etiketleri artık teslimat-sonucu:**
  "messaging X…" etiketi akıştaki araç NİYETİNDEN değil otobüsün teslimat
  SONUCUNDAN üretilir (`BusOptions.onAgentActivity`): gerçek alıcı adı,
  "replying to the user…", reroute'ta "reporting to the lead…", bounce'ta
  "reply held — budget spent". Kullanıcının bildirdiği bug ("messaging user
  diyor ama o an başka ajanla konuşuyor") kökten kapandı — çoklu-gönderimli
  turlar ve yarım-akmış input yanlış etiket üretemez. Canlı doğrulandı.
- ✅ (2026-07-17, v1.4) **Takım hafızası:** `.quorum` (kararlar + pano) artık
  takımın kalıcı hafızası olarak ajanlara BAĞLI — spawn'da system prompt'a
  kompakt "Team memory" özeti (son 8 karar + açık işler,
  `protocol.ts teamMemoryDigest`) + `list_decisions` MCP aracı (detaylar,
  son 20 kayıt). Uygulama yeniden başlayınca takım lobotomize olmaz. Vault
  ise lead'e özel kalır (kullanıcı kararı: ajanlar vault'a bağlanmaz;
  vault↔takım köprüsü lead'in kürasyonudur). Canlı kanıt: yalnız diskte
  duran karar, taze ajan tarafından gerekçesiyle bilindi.
- ✅ (2026-07-17) **@everyone toggle butonu kaldırıldı** (kullanıcı kararı):
  düz yazı zaten tüm takıma gittiği için işlevsizdi; yazılı `@everyone`
  komutu mekanizmada duruyor. Mesaj animasyonu "kavisli yörünge"ye geçti
  (animasyon laboratuvarı #8): yay uçuş yönünün soluna bükülür, çift yön zıt
  yaylarda uçar, sönen kuyruk + ease hareket.
- ✅ (2026-07-17) **Tek CLAUDE.md tüm takımı yönetir:** proje açılışında
  CLAUDE.md yoksa Quorum-uyarlı şablon BİR KEZ oluşturulur (var olan dosyaya
  asla dokunulmaz; scratch modda üretilmez). Lead dosyayı stok Claude Code
  davranışıyla okur; ajanlara spawn'da system prompt'a "Project instructions"
  bölümü olarak enjekte edilir (`src/main/claudeMd.ts`, 30k karakter tavan) —
  `settingSources: []` izolasyonu korunur, yalnız bu tek dosya sızar. Her
  spawn'da yeniden okunur (model değişimi/restart güncel halini alır). Canlı
  kanıt: CLAUDE.md'ye yazılan işaret-kelime kuralına ajan cevabında uydu;
  özelleştirilen dosya yeniden açılışta ezilmedi.
- ✅ (2026-07-17) **Team Lead parıltısı iki seviyeli:** parlak nabız =
  köprü trafiği ("driving the team…", birinci-el bilgi); yumuşak hare =
  lead oturumu açık projede çalışıyor ("working…") — Claude Code hook'ları
  (UserPromptSubmit/PostToolUse/Stop) stdin JSON'unu `/lead-activity` ucuna
  iletir; yalnız cwd'si açık projenin içindeki oturumlar sayılır,
  oturum-bazlı claim'ler 2 dk ping'siz kalırsa düşer (kaçan Stop parıltıyı
  süresiz bırakamaz). Brief §3.6 uyumlu: hook'lar İKİNCİL telemetri, salt
  kozmetik — hiçbir mekanizma kararı buna bağlı değil. Canlı kanıt: hook'lu
  gerçek oturumun araç çağrısı bloğu 'working'e geçirdi; cwd eşleşmeyen
  oturum claim alamadı; köprü çağrısı 'driving' ile ezdi.
- ✅ (2026-07-16, v1.2) **Claude Code köprüsü (dış lead):** Quorum main,
  127.0.0.1:8484'te MCP endpoint'i barındırır (`src/main/bridge.ts`;
  Streamable HTTP, istek-başına stateless sunucu). Kullanıcının kendi Claude
  Code oturumu `ask`/`roster`/`replies` araçlarıyla takımın lead'i olur;
  zengin sohbet editörde, Quorum penceresi ajan-arası trafiğin canlı monitörü.
  `ask` composer'la birebir aynı yönlendirme (`sendUserInput`); `replies`
  long-poll (varsayılan 45 sn — MCP istemci zaman aşımının altında). MCP
  izinli arayüz (brief §3.6). Ayrıca hız: marketplace eklemeleri varsayılan
  haiku. E2E doğrulandı: dış MCP istemcisi → ask → ajan cevabı 8 sn'de
  replies'tan döndü, canvas eşzamanlı görselleştirdi.
- ✅ (2026-07-16, v1.1) **ESC = interrupt:** meşgul her ajanın devam eden turu
  SDK'nın belgeli `interrupt()` metoduyla kesilir (arka kapı yok); kuyruktaki
  mesajlar korunur, `Bus.cancelReplyDebt` kesilen ajanın silent-turn dürtmesini
  bastırır (yoksa dürtme ajanı hemen yeniden çalıştırırdı). Modal açıkken ESC
  önce modalı kapatır. Canlı doğrulandı: uzun görev → ESC → 2 sn'de idle,
  yeniden tetiklenme yok.
- ✅ (2026-07-16) Varsayılan açılış **sıfır ajan** — takım marketplace'ten
  kurulur (üst sınır `MAX_AGENTS = 5`). Hazır takımla açmak için
  `QUORUM_PROJECT=<team.json içeren dizin>` (verify/demo script'leri example'ı
  böyle yükler).
- ✅ (2026-07-16) **Ürünleştirme:** ürün adı **"Quorum"** (marka araştırması:
  CLAUDE tescilli marka, üçüncü-taraf ürün adında kullanım riskli; Claude Code
  yalnız tanımlayıcı biçimde anılır + README'de ilişkisizlik notu).
  `npm run package:mac` → electron-builder ile imzasız DMG (`release/`);
  paketli uygulamada durum dizini asar salt-okunur olduğundan
  `~/Library/Application Support/Quorum` (userData) kullanılır.
- ✅ (2026-07-16) **Proje-başına çalışma (editör modeli):** header'daki proje
  rozeti → yerel klasör seçici; ajanların cwd'si seçilen proje klasörüdür.
  Takım bileşimi + ajan-başı model/izin + kararlar + pano + yerleşim
  `<proje>/.quorum/` altında kalıcıdır (`saveTeam`, her mutasyonda yazılır);
  proje yeniden açıldığında aynı takım geri gelir. Son proje
  `userData/settings.json`'da hatırlanır (yalnız kullanıcının bilinçli
  seçiminde yazılır; `QUORUM_PROJECT` script yolu hafızayı ezmez). Takım
  çözümleme sırası: `.quorum/team.json` (canlı) → kök `team.json` (tohum,
  example/) → boş takım. Canlı e2e doğrulandı: ekle→kapat→aç→ajan yerinde.

## 8. Claude Code "agent teams" ile ilişki

Fonksiyonel çekirdek (isimli oturumlar, aralarında mesajlaşma, görev panosu,
kullanıcıyla doğrudan konuşma) Anthropic'in **deneysel** agent teams özelliğiyle
örtüşür. Bilinçli olarak kendimiz yapıyoruz, çünkü (Temmuz 2026 itibarıyla):

- Teams **deneysel ve varsayılan kapalı** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`);
  davranışı/hook olayları sürümler arasında değişebilir.
- Bölünmüş panel görünümü tmux/iTerm2 ister; **VS Code terminali, Windows
  Terminal ve Ghostty'de çalışmaz.** In-process mod `/resume`/`/rewind`'de kalıcı değil.
- Görselleştirme katmanı (canvas) Anthropic'ten hiçbir zaman gelmeyecek — bu katman
  her durumda bizim ürünümüz.

**Sigorta:** §3.5'teki değiştirilebilir arka uç ilkesi. Teams GA olduğunda mesaj
taşıma katmanı ona geçirilebilir; kopyaladığımız kısım bilinçli olarak ince tutulur.

*(2026-07-09 doğrulama — resmî [agent-teams dokümanı](https://code.claude.com/docs/en/agent-teams)
v2.1.178+ ile karşılaştırıldı: Quorum resmî özelliğin tüm çekirdek yeteneklerini
karşılıyor (lead+teammate ayrı bağlamlar, aralarında mesajlaşma, paylaşımlı görev
panosu + atomik claim, doğrudan konuşma, subagent tanımından teammate = marketplace,
izin yükseltme) ve resmî özellikte OLMAYAN dört şeyi ekliyor: GUI/canvas (resmî
terminal-only, split-pane tmux/iTerm2 ister, VS Code/Windows/Ghostty'de çalışmaz),
karar protokolü + kalıcı kararlar, çalışma zamanı model/izin değişimi, marketplace.
Aynı abonelik-yalnız maliyet modeli, API yok.)*

## 9. Yol haritası

| Faz                                | Kapsam                                                                                                                         | Doğrulama                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 — Çekirdek kanıt**   | 2`claude --agent` oturumu stream-json modunda + `send_message` MCP aracı + otobüs üzerinden mesaj turu (kuyruklamasız) | A'nın mesajı B'yi uyandırır, B cevap verir;`--agent` + stream-json + `--resume` birlikte çalışır; izin protokolü yakalanır; kullanıcı her ikisiyle konuşur                                                                                                                                     |
| **P1 — Güvenilir otobüs** | Meşguliyet takibi (Stop hook) + kuyruk + tur bütçesi                                                                        | Meşgul ajana mesaj kaybolmaz; 8+ mesajlık zincire müdahale notu düşer                                                                                                                                                                                                                                      |
| **P2 — Karar katmanı**     | Takım protokolü prompt bölümü +`record_decision` + kararlar dosyası                                                    | Çatışmalı soru verilir ("pgvector mı Pinecone mı"), ajanlar kendi başına karara varır                                                                                                                                                                                                                  |
| **P3 — Canvas**             | Blok=oturum görselleştirme, mesaj okları, kararlar paneli (AgentBoard bileşenleri uyarlanır)                              | Trafik ve durum canlı izlenir ·_(P3 dilim-1 2026-07-09: Electron+Vite+React iskeleti; canvas blokları, ajan-ajan mesaj okları, toplantı odası, izin kartı, karar paneli canlı doğrulandı. AgentBoard'dan IPC deseni LIFT, Canvas/xterm SKIP. Bkz. `p3/BULGULAR.md`.)_                             |
| **P4 — Desenler & pano**    | `claim_task`/`complete_task`, koordinatör şablonu, yarışma/eleştiri desenleri                                         | Çok ajanlı gerçek bir iş uçtan uca ·_(2026-07-09: `add_task`/`claim_task`/`complete_task` + atomik sahiplenme `src/tasks.ts`'te; koordinatör deseni canlı doğrulandı — iki worker iki görevi çift iş olmadan böldü. Yarışma/eleştiri desenleri ileride. Bkz. `p4/BULGULAR.md`.)_ |

## 10. Riskler ve açık sorular

- [ ] **Programatik mod uyumluluğu:** ✅ P0'da doğrulandı (2026-07-08, bkz.
  `p0/BULGULAR.md`): `--agent` + stream-json + `--resume` + MCP birlikte
  çalışıyor. İzin yakalama ham CLI'de YOK; karar: taşıma katmanı Agent SDK
  (`canUseTool` üç araç sınıfını da yakalıyor, abonelik kimliğiyle çalışıyor).
  (Önceki en büyük risk olan PTY enjeksiyonu 2026-07-08 kararıyla tamamen
  kaldırıldı — taşıma katmanı yalnızca belgeli stream-json/SDK.)
- [ ] **Sohbet UI iş yükü:** Ham terminal bedavaydı; araç çağrılarını, izin
  kartlarını ve akışı iyi çizen bir sohbet görünümü gerçek geliştirme işi.
  Karşılığı: toplantı odasına ve ürün kalitesine doğrudan hizmet eder.
- [ ] **Kota tüketimi:** N paralel oturum plan limitini N kat hızlı yer. UI'da oturum
  başına kullanım göstergesi düşünülebilir.
- [x] **Mesaj fırtınası:** Tur bütçesi ikili zincirleri keser. *(2026-07-09
  güncelleme: yayın YAPILDI — `@everyone` + canvas çoklu seçim. Grup görevi
  `[TEAM TASK]` zarfıyla koordine; "sessiz tur" dürtmesi ve görev dedup'ı
  fırtına/çift-iş kenar durumlarını yumuşatır. Çok ajanlı yayın fırtınası
  ölçekli olarak henüz stres-test edilmedi.)*
- [ ] **Oturum çökmesi:** PTY ölürse kuyruktaki mesajlar ne olur? (Bekletilir; blok
  "çevrimdışı" gösterilir; `--resume` ile diriltme denenir.)
- [ ] **Aynı projede dosya çakışması:** İki ajan aynı dosyayı düzenlerse? v1'de
  konvansiyonla (protokole "dosya sahipliği ilan et" kuralı); ileride worktree.

## 11. AgentBoard'dan devralınacaklar

*(Gerçekleşme durumu 2026-07-09 işaretlendi. Karar: kod kopyalanmadı, desen
alındı — Quorum bağımsız repo.)*

- ~~Hook sunucusu (Unix socket, olay şeması)~~ → **DEVRALINMADI, GEREK KALMADI.**
  No-backdoors ilkesi (§3.6) sayesinde durum tamamen SDK olay akışından geliyor;
  hook sunucusuna hiç ihtiyaç olmadı. (Bu, brief'in "hook yalnızca ikincil
  telemetri olabilir" öngörüsünü doğruladı — ikincil bile gerekmedi.)
- ✅ Canvas altyapısı: renderer sıfırdan yazıldı (React); xterm/PTY ALINMADI.
- ~~Hook kurulum deseni (`installHooks`)~~ → **GEREK KALMADI** (hook yok).
- ✅ IPC deseni (typed contract + envelope + preload contextBridge) AgentBoard'dan
  uyarlandı (LIFT); `Canvas.tsx` uyarlanmadı, sıfırdan (SKIP).
- ⏳ Proje izolasyonu (cwd → proje kökü): tek proje/örnek takımla çalışıyor;
  çok-proje seçici ertelendi.

## 12. Subagent modeliyle karşılaştırma

Quorum, subagent modelinin **yerini almaz** — üstüne bir işbirliği katmanı ekler.
Quorum'daki her ajan kendi işinde subagent kullanmaya devam eder.

**Subagent modelinin (mevcut yapı) güçlü yanları:**

- *Tek bütünleştirici akıl:* Orkestratör her sonucu tek bağlamda birleştirir,
  çelişkileri yakalar, sentezi yapar. Quorum'da bütünlüğü gören kimse yok —
  protokole emanet.
- *Kota verimliliği:* Subagent doğar-yapar-ölür. Quorum'da N kalıcı bağlam +
  her mesaj teslimi yeni bir turn; 8 mesajlık bir müzakere, tek turn'lük
  sentezin 5-10 katı token yakabilir.
- *Hız:* Paralel salma + otomatik sonuç toplama sıkı bir döngü; Quorum'un
  asenkron yazışması yapısal olarak yavaş.
- *Sıfır altyapı:* Bugün çalışıyor; otobüs/kuyruk/PTY enjeksiyonu bakımı yok.

**Quorum'un güçlü yanları:**

- *Doğrudan konuşma* — subagent modelinde yapısal olarak imkânsız.
- *Kalıcı uzman kimliği:* Ajan her görevde yeniden doğmaz; alanının geçmişini
  kendi oturumunda biriktirir.
- *Müzakere ve karar:* Çapraz inceleme, öneren-eleştiren, oylama — subagent'lar
  birbirini eleştiremez.
- *Gözlemlenebilirlik + dayanıklılık:* Blok=oturum kesinliği; tek oturum çökünce
  sistem yaşar.
- *Uzun soluklu paralel işler:* Ajanlar saatlerce ayrı işlerde çalışır; subagent
  tek isteğin ömrüyle sınırlı.

**Bedelleri:** ortak durum problemi (iş tekrarı, çakışan düzenlemeler), izin
yüzeyi × N, çok oturumlu davranışın debug zorluğu, inşa + bakım maliyeti.

**Turnusol testi:**

| İşin doğası                                                                                           | Doğru araç          |
| --------------------------------------------------------------------------------------------------------- | --------------------- |
| "Şunu yap, sonucu getir" — tek teslimat, bölünebilir iş                                              | Subagent (mevcut mod) |
| "Uzmanlarla ayrı ayrı konuşayım, tartışsınlar, karar alsınlar, gün boyu paralel çalışsınlar" | Quorum                |

**Karar:** Quorum, AgentBoard'un *yeni bir çalışma modu*dur; subagent modu emekliye
ayrılmaz. Büyük yatırım öncesi P0 iki şeyi ucuza test eder: (1) PTY enjeksiyonu
güvenilir mi — teknik risk; (2) müzakere kalitesi gerçek mi, yoksa token yakan
nezaket ping-pong'u mu — ürün riski.

## 13. Pazar konumu (GitHub araştırması, 2026-07)

**Birebir benzeri yok; terminal tarafı kalabalık, GUI tarafı boş.**

| Proje                                                              | ⭐ (~) | Ne yapıyor                                                       | Quorum'dan farkı                                                                |
| ------------------------------------------------------------------ | ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [claude-flow/Ruflo](https://github.com/ruvnet/ruflo)                | 63k    | Swarm topolojileri, web UI, 100+ ajan, çoklu sağlayıcı        | Canvas'lı eş-düzey mesajlaşma görselleştirmesi yok; Claude'a özgü değil |
| [claude-squad](https://github.com/smtg-ai/claude-squad)             | 8k     | Çoklu oturum yöneticisi (tmux + git worktree), TUI              | Ajanlar**birbiriyle hiç konuşmuyor** — sadece izolasyon                 |
| [Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) | 1.8k   | tmux panelleri arasında script'le hiyerarşik mesaj              | GUI yok, protokol yok, eş-düzey değil                                         |
| [claude-swarm](https://github.com/parruda/claude-swarm)             | —     | YAML tanımlı Claude Code ağacı, MCP ile hiyerarşik iletişim | GUI yok, eşler arası değil                                                    |
| [agent-flow](https://github.com/patoles/agent-flow)                 | 1k     | Tek oturumun subagent ağacını node grafiği olarak gösterir   | Oturum-içi; bağımsız oturumlar arası mesajlaşma değil                     |

**Boşluk (whitespace):** Bağımsız isimli Claude Code oturumlarının eş-düzey
mesajlaşmasını + karar protokolünü gösteren canvas'lı GUI **yapılmamış**. Bulunan
tüm GUI araçları (agent-flow, coide, agentgui) oturum-içi subagent ağacını
görselleştiriyor. Anthropic'in kendi repo'sundaki
[issue #24537](https://github.com/anthropics/claude-code/issues/24537)
("Agent Hierarchy Dashboard") tam bu boşluğu talep eden açık bir topluluk isteği —
talep belgeli.

**Yıldız beklentisi:** Benzer araçlar 6-12 ayda 1k-8k bandına oturmuş (kategori
sıcak, 2025-2026 patlaması). Doğru lansmanla 1-3k gerçekçi hedef. Kritik başarı
faktörü teknik değil: **iyi README + iki ajanın canvas'ta müzakere edip karara
vardığı ~30 sn'lik demo GIF'i** + HN/Reddit/X lansmanı. "API'siz, aboneliğinle
çalışır" mesajı kategorideki en büyük şikâyete (API maliyeti) cevap verdiği için
güçlü bir farklılaştırıcı. Risk: Anthropic agent teams'i GA yapıp kendi
görselleştirmesini eklerse rüzgâr değişir (issue açık olduğuna göre yakın vadede
değil).

## 14. Toplantı Odası (Meeting Room)

Kullanıcı ajanlarla tek tek konuşmak yerine **tek bir ortak pencerede** takımı
yönetebilir. Toplantı odası yeni bir LLM oturumu DEĞİLDİR — mesaj otobüsü
trafiğinin tek akışta görünümü + kullanıcı mesajlarını yönlendiren kural seti
("LLM'e vekillik yok" ilkesi korunur).

**Görünüm:** Ajanlar arası tüm mesajlar, kararlar ve kullanıcı mesajları
kronolojik tek akışta (Slack kanalı gibi). Birebir ajan sohbet penceresi
kalkmaz; toplantı odası üstüne gelen katmandır.

**Üç çalışma modu (kullanıcı mesajı kime gider, kim cevap verir):**
*(Yönlendirme gerçeklendi 2026-07-09; teslimat politikası — "kim cevap verir"
kısmı — 2026-07-16'da mekanizmaya taşındı. `src/bus.ts routeUserInput` +
`deliver`. Taksonomi kararı: kodda 4 dallanma vardır ama kullanıcıya dönük dil
3 moddur — tek hedefe `@isim` ile de tek-blok seçimiyle de ulaşılır, ikisi aynı
moddur; `@everyone` da "tüm takım seçili" grup görevidir.)*

| Mod | Yazım | Teslimat | Kim cevap verir |
| --- | ------ | --------- | ---------------- |
| **Tüm takım (varsayılan, 2026-07-17)** | Mention'sız, seçimsiz mesaj (dış-lead kurulumunda — team.json'da lead bayrağı yokken) | TÜM ajanlara `[TEAM TASK]` grup görevi — composer yalnız ajanlarla konuşur; Team Lead'e ulaşmanın tek yolu Claude Code oturumu | Her katılımcı tam 1 kez |
| **Lead (yalnız team.json `lead` bayrağıyla — example/script'ler)** | Mention'sız, seçimsiz mesaj | Lead'e, `[LEAD BRIEF]` çerçevesiyle (ekip listesi + böl/birleştir talimatı) | Yalnız lead, TEK birleşik cevap; ekip üyesinin user mesajı lead'e yönlenir (lead isolation) |
| **Tek hedef** | `@ajan-adı mesaj` VEYA canvas'ta tek blok seçili | Sadece o ajana, zarfsız | Adreslenen ajan kullanıcı kanalının sahibidir (bir sonraki kullanıcı girişine dek); başka ajanın user mesajı göndericiye geri döner (bounce) |
| **Grup görevi** | Canvas'ta 2+ blok seçili VEYA `@everyone` | Tam katılımcı kümesine `[TEAM TASK — participants: …]` + `[delivery]` zarfı | Önce istişare/yakınsama; sonra HER katılımcı kullanıcıya kendi uzmanlık diliminden TAM BİR cevap — katılımcı-başı 1 cevap bütçesi otobüste zorlanır |

**Teslimat politikası mekanizmadadır (2026-07-16):** "Kim, kullanıcıya kaç kez
konuşur" kuralı prompt'a değil `Bus.deliver`'a yaşar. Grup modunda bütçeyi aşan
veya adreslenmemiş bir ajanın user mesajı kullanıcıya sızmaz; göndericiye
`REPLY_BUDGET_NOTE` ile geri döner (bounce cevap yükümlülüğü doğurmaz —
silent-turn dürtmesi tetiklenmez, gevezelik döngüsü mekanik olarak kesilir).
Politika "en son kullanıcı girişi" başına tutulur; görev-kimliği bazlı paralel
takip ileriki iş. Gerekçe: canlı 4-mod smoke'unda (2026-07-16) lead
aktarmasının tek hedefte +50 sn gecikme, grup modunda 10 mesajlık kapanış
gevezeliği ürettiği ölçüldü; kullanıcı `@everyone` derken zaten "ekibi ayrı
ayrı duymak istiyorum" beyanında bulunur.

**Takım boyutu sınırı (2026-07-16):** `MAX_AGENTS = 5` — otobüs mekanizmasında
(constructor + `addRosterEntry`); marketplace ekleme yolu da bu sınırdan döner.
İleride ihtiyaca göre yükseltilebilir.

**Maliyet gerekçesi:** Bir ajanı uyandırmak — alakasız deyip susacak olsa bile —
tam bir turn yakar. Her yayının N ajana gitmesi N turn öder; bu yüzden varsayılan
rota lead'dir. Rota önceliği: @mention > seçim > lead (birim testli davranış).

**Ajan tarafı:** Ajanlar arası danışma zaten §5 protokolüyle çalışır; toplantı
odası bu trafiği kullanıcıya canlı gösterir. Persona bir *bakış açısıdır, bilgi
sınırı değil* (2026-07-16): tek-hedef modda alan dışı soruya ajan yine de genel
bilgisiyle cevap verir — tek satır "alanım dışı" notu + uygun takım arkadaşına
işaret; rol gerekçesiyle cevap reddi protokolce yasak (canlı doğrulandı:
data-engineer'a EV sorusu → uyarı + tam cevap + thermal-engineer yönlendirmesi). Ajanların `.md` tanımları aynen
bugünkü subagent formatıdır (`claude --agent` aynı dosyayı okur); Quorum yalnızca
takım protokolü bölümünü ekler. İç subagent kullanımı varsayılan **kapalı**
(ajan `tools:` listesinden `Task` çıkarılır); ihtiyaç halinde ajan bazında açılır.

*Yol haritası etkisi: Toplantı odası UI'ı P3 (Canvas) kapsamına girer;
yönlendirme kuralları P1'deki otobüsün parçasıdır.*

## 15. Mimari görsel

İnteraktif topoloji diyagramı (4 iletişim senaryosuyla): `quorum-mimari.html`
(bu klasörde) · yayınlanmış hali:
https://claude.ai/code/artifact/bb5b7a2d-8cd8-4d4c-8ae3-3d77795d03fc
