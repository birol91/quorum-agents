# P1 Bulguları — Güvenilir Otobüs

> Koşum tarihi: 2026-07-08 · Kapsam (brief §9): meşguliyet takibi + kuyruk +
> tur bütçesi; kullanıcı yönlendirme kuralları (brief §14) dahil.
> Kod: `src/bus.ts`, `src/session.ts`, `src/protocol.ts`, `src/tools.ts` (TypeScript,
> Node 25 type stripping ile doğrudan çalışır — derleme katmanı yok).

## Doğrulama

**Birim testleri (`test/bus.test.ts`, LLM'siz sahte oturumlar, 8/8 yeşil):**
- Boşta hedefe anında teslim + `[from <gönderen>]` öneki
- Meşgul hedefe FIFO kuyruk; hiçbir mesaj kaybolmaz, sıra korunur
- Çevrimdışı hedefin kuyruğu tutulur; oturum dönünce boşalır
- Bilinmeyen hedef düşürülür ama raporlanır (`onDrop`), fırlatmaz
- Tur bütçesi: N. ardışık çift mesajına not; her N'de tekrar; kullanıcı
  devreye girince zincir sıfırlanır
- Yönlendirme: mention'sız → lead, `@ajan` → o ajan, `@herkes` → yayın
- `drain()`: tüm turlar bitip kuyruklar boşalınca çözülür

**Canlı smoke 1 — kuyruk kaybı yok (`p1/smoke-queue.mjs`): GEÇTİ.**
Tek ajana aynı anda 3 mesaj → 2'si ilk turun arkasında kuyruklandı, üçü de
sırayla cevaplandı (ACK 1/2/3, 17.9 sn, 3 tur). Yol haritası ölçütü ("meşgul
ajana mesaj kaybolmaz") gerçek akışta doğrulandı.

**Canlı smoke 2 — tur bütçesi notu (`p1/smoke-budget.mjs`): GEÇTİ.**
Bütçe 4'e indirilerek (ucuz koşum) iki inatçı ajan tabs-vs-spaces münazarasına
sokuldu. Not tam 4. çift mesajında enjekte edildi; **notun hemen ardından**
taraflar KABUL'e geçti ve karar kullanıcıya raporlandı (toplam 6 çift mesajı).
Not yalnız enjekte edilmiyor — müzakereyi gerçekten karara itiyor.

## Tasarım notları

- Teslim garantileri (kuyruk, bütçe, yönlendirme) tamamen mekanizmada
  (`Bus` sınıfı) — prompt'ta yalnızca iletişim görgü kuralları var (brief §3.4).
- Oturum durumu (`idle/busy/offline`) akışın kendi `result` olayından ve süreç
  yaşam döngüsünden geliyor; çıkarım yok (brief §3.6). Hook sunucusu P1'de hiç
  gerekmedi.
- `SdkSession.close()` önce süren turu bekliyor (drenaj) — P0/E5'teki kapanış
  yarışı çözüldü.
- Çevrimdışı oturumun kuyruğu tutuluyor; `--resume` ile diriltme mekanizması
  P0/E2'de kanıtlı, otomatik diriltme UI ile birlikte (P3) bağlanacak.

## Açık gözlem (güvenilirlik)

Seyrek bir pürüz iki kez görüldü (E5 ilk koşusu, smoke-budget ilk koşusu):
haiku ajanı bir turu tamamlıyor ama beklenen `send_message` çağrısını yapmıyor
(ör. 653 token üretip otobüse hiç mesaj bırakmadı); tekrar koşuda kayboluyor.
Mekanizma mesaj kaybetmiyor — bu bir LLM davranış pürüzü. Adaylar: protokol
prompt'unu güçlendirme, kritik akışlarda sonnet, UI'da "cevapsız tur" göstergesi.
P2'de izlenecek.
