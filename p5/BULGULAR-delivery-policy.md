# Mod-Bazlı Teslimat Politikası + MAX_AGENTS — Bulgular

> Koşum tarihi: 2026-07-16 · Soru: "Kim kullanıcıya cevap verir?" kuralı moda
> bağlanınca (tek hedef → ajanın kendisi; grup → her katılımcı tam 1 kez)
> canlıda çalışıyor mu, gevezelik kesiliyor mu?

## Önceki durum (aynı gün ölçüldü, `scratchpad/smoke-4modes`)

Lead isolation koşulsuzdu: `@isim` sorusunun cevabı bile lead üzerinden dönüyordu
(+50 sn aktarma); seçilmemiş lead seçili-grup görevinde son sözü söylüyordu;
`@everyone`'da kullanıcıya 10 mesajlık kapanış gevezeliği adreslendi ("iş
kapandı" ping-pong'u). "Tek cevap" kuralı yalnız prompt'ta yaşıyordu.

## Yapılan

- **`src/bus.ts`:** Teslimat politikası mekanizmaya taşındı. `routeUserInput`
  her kullanıcı girişinde modu ve hakları belirler: lead modunda eski davranış
  (lead tek ses, reroute); tek hedefte adreslenen ajan kanalın sahibi; grup
  görevinde katılımcı-başı **1 cevap bütçesi**. Bütçe üstü / adreslenmemiş
  mesaj kullanıcıya sızmaz — göndericiye `REPLY_BUDGET_NOTE` ile döner ve bu
  not cevap yükümlülüğü doğurmaz (silent-turn dürtmesi tetiklenmez; gevezelik
  döngüsü mekanik kesilir). `MAX_AGENTS = 5` (constructor + `addRosterEntry`).
- **`src/main/manager.ts`:** Marketplace ekleme yolu bütçeden döner ("Team is
  full" hatası). Not: renderer bu hatayı sessizce yutuyor (`.catch(() => {})`)
  — kart eklenmez ama toast yok; UI geri bildirimi ileriki iş.
- **`src/protocol.ts` + `[TEAM TASK]` zarfı:** "önce istişare/yakınsama, sonra
  HER katılımcı kendi uzmanlık diliminden TEK cevap; tekrar ve kapanış
  gevezeliği yok" + doğrudan modda "cevabın sahibi sensin".
- **Birim test:** 6 yeni test (`test/bus.test.ts`), 30/30 geçer.

## Canlı smoke (`p5/smoke-delivery-policy.mjs`, 3 sonnet ajanı): ALL PASS

| Senaryo | Kullanıcıya ulaşan | Bounce | Süre |
| --- | --- | --- | --- |
| SINGLE-TARGET (`@data-engineer`) | data-engineer: 1 (15 sn'de, lead aktarması yok) | — | 21 sn |
| GROUP-SELECTED (2 seçili, lead dışarıda) | prompt-engineer: 1, data-engineer: 1 — her biri kendi dilimi, ortak kararı referanslıyor | prompt-engineer ×1 | 76 sn |
| GROUP-EVERYONE | 3 katılımcı × tam 1 cevap, her biri kendi açısı (retrieval / staleness / prompt) + yakınsanan ortak risk | data-engineer, ai-engineer | 170 sn |

Öne çıkanlar: tek hedefte cevap süresi 90 sn → 21 sn (lead aktarması kalktı);
seçilmemiş lead artık seçili-grup görevinde hiç konuşmuyor; eski koşuda 10
mesaj olan kullanıcı-adresli trafik `@everyone`'da tam 3'e indi — fazlası
bounce'ta görünüyor, kullanıcıya değil. İçerik tekrarı yok: ajanlar önce
yakınsayıp sonra kendi dilimlerini yazdı (protokol teşviki; mekanik garanti
değil).

**Sonuç:** "Teslimat politikası adresleme modunu takip eder" ilkesi ve takım
boyutu sınırı artık mekanizmada; üç mod da canlı doğrulandı. Brief §14 ve
README senkronlandı.
