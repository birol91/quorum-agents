# P3 Bulguları — Canvas (Electron uygulaması)

> Koşum tarihi: 2026-07-09 · Kapsam (brief §9 P3): blok=oturum görselleştirme,
> mesaj okları, kararlar paneli + (brief §14) toplantı odası + izin onay kartı.
> Dilim-1: yürüyen iskelet — tüm UX parçaları canlı, tek statik yerleşim.

## Ne kuruldu

- **Stack (AgentBoard deseninden):** Electron + Vite + React. AgentBoard'un
  IPC deseni (typed contract + envelope + preload contextBridge) LIFT edildi;
  `Canvas.tsx` ve xterm SKIP (Quorum'un modeli canlı oturum + ajan-ajan trafik,
  AgentBoard'unki statik ajan tanımı — bileşen sıfırdan yazıldı).
- **main süreç:** `src/main/manager.ts` P0-P2 çekirdeğini (bus + session +
  decision store) bir `team.json`'dan ayağa kaldırır ve IPC ile renderer'a
  canlı olay akışı yayar. İzin kartı akışı `src/main/permissions.ts` ile:
  `canUseTool` bir promise'e köprülenir, her araç çağrısı UI'da onay kartı olur.
- **renderer:** ektek referans görselin paletiyle (koyu lacivert zemin, neon
  camgöbeği/mor bloklar, glow, kesikli mesaj okları). Canvas blokları (busy=glow,
  offline=kesikli, lead rozeti), toplantı odası akışı (@-yönlendirme composer'ı),
  izin kartları, kararlar paneli.

## Doğrulama (canlı, Playwright + Electron)

`scripts/verify-ui.mjs` uygulamayı GUI olarak açtı (kotasız `QUORUM_NO_SESSIONS`
modu), sahte olaylar enjekte etti, ekran görüntüsü aldı. DOM sayımı:
`blocks:2 busy:2 arrows:2 perms:1 decisions:1 messages:3` — tüm parçalar render
edildi. İki ekran: boş board (ajanlar offline) + aktif board (glow, ok, kart, karar).

## En büyük engel: `ELECTRON_RUN_AS_NODE=1`

Uzun bir hata zinciri (`electron.app` undefined, `ERR_REQUIRE_ESM`, ESM/CJS
preparse patlamaları) sonunda tek bir kök nedene indi: **ortamda global
`ELECTRON_RUN_AS_NODE=1` set edilmiş**; bu Electron'u GUI yerine düz Node olarak
çalıştırıyor, `require('electron')` API yerine binary yolu (string) döndürüyor,
pencere hiç açılmıyordu. Bu değişkeni çocuk süreç ortamından silince uygulama
anında açıldı. Sürücü ve verify script'i artık bunu kendileri temizliyor
(SKILL.md gotcha'ya işlendi).

Yol boyunca çözülen gerçek kısıtlar (kalıcı): Electron 33 main **CJS olmalı**
(ESM main dahili `electron` modülünü yükleyemiyor); Agent SDK **ESM-only**, bu
yüzden CJS main onu dynamic `import()` ile yüklüyor (`session.ts`, `tools.ts`);
`quorumServerFor` bu yüzden async oldu, P1/P2 smoke'ları await'e uyarlandı.

## Bilinçli kısıtlar (P4'e)

- Statik yerleşim (ajanlar sabit satırda); sürükleme/otomatik yerleşim yok.
- Mesaj okları son 6 ajan-ajan mesajından türetiliyor; kalıcı thread görünümü yok.
- Karar paneli düz liste; gerekçe genişletme/gruplama yok.
- Oturum başlatma canlı ama bu dilimde kotasız modda doğrulandı; uçtan uca
  canlı müzakere UI'da P4 kapsamında (kota müsaitken) izlenecek.
