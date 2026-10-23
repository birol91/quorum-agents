# P3 Dilim-2 Bulguları — Sürükleme, Thread, Canlı Müzakere

> Koşum tarihi: 2026-07-09 · Kapsam: kalıcı yerleşim + sürükleme, mesaj thread
> görünümü, ve **canlı iki ajan müzakeresinin gerçek UI'da izlenmesi**.

## Ne eklendi

- **Sürükleme + kalıcı yerleşim:** bloklar sürüklenebilir; son konum
  `example/.quorum/layout.json`'a `quorum:saveLayout` IPC'siyle yazılır,
  açılışta snapshot ile geri yüklenir. (`src/main/manager.ts` layout deposu,
  `src/renderer/App.tsx` Canvas sürükleme.)
- **Thread görünümü:** toplantı odasında bir ajan-ajan mesajına tıklamak o
  ikilinin (from|to) thread'ini seçer; thread dışı mesajlar ve bloklar
  soluklaşır, üstte "thread: A ↔ B ✕" chip'i çıkar.

## Doğrulama

**Statik (kotasız, `scripts/verify-ui.mjs`):** sürükleme sonrası
`layout.json` diske yazıldı (`{"ai-engineer":{"x":230,"y":180}}`), thread
seçilince thread-clear chip'i belirdi ve thread dışı mesaj soluklaştı
(`dimmedMsgs:1`). Ekran: `shots/03-thread-and-drag.png`.

**CANLI (kotalı tek koşu, `scripts/verify-live.mjs`): GEÇTİ.**
Gerçek `claude` oturumlarıyla uygulama açıldı, iki ajan online oldu, toplantı
odasından çatışmalı soru gönderildi (pgvector vs Pinecone). Ajanlar canlı
müzakere etti (5 mesaj, karşılıklı KABUL) ve kararı kaydetti — **hepsi gerçek
UI'da izlendi**:
- Karar: "Use pgvector on the existing Postgres fleet (HNSW + halfvec
  quantization) instead of Pinecone; pilot at 2M to benchmark recall@10, p99
  latency, rebuild time before scaling to 50M."
- Ekran `shots/live-02-decided.png`: iki busy blok (glow), aralarında canlı
  mesaj oku, toplantı odasında KABUL/KABUL müzakeresi, karar panelinde gerekçe.
Bu, brief §13'ün "iki ajanın canvas'ta müzakere edip karara vardığı demo"
hedefinin canlı gerçekleşmesi — lansman hero görseli buradan çıkacak.

## Yol boyunca çözülen kritik hata

Canlı koşu ilk denemede ajanlar hiç online olmadı. Main süreç stderr'i kök
nedeni verdi: `dist/tools.js`'te `ERR_REQUIRE_ESM`. **tsc `module: commonjs`
altında dinamik `import()`'u `require()`'a downlevel ediyordu** — ESM-only
SDK'yı `require` etmek patlıyor, session hookup için yaptığım tüm lazy-import
çabası boşa gidiyordu. Çözüm: `src/esm-import.ts` — `new Function('return
import(specifier)')` ile dinamik import'u tsc'nin dönüşümünden gizleyip
çalışma zamanına gerçek `import()` olarak taşımak. Hem CJS (Electron) hem ESM
(test/smoke) altında çalıştığı doğrulandı; 16/16 test yeşil.
