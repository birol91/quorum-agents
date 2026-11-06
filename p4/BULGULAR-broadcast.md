# Koordineli Yayın (@everyone) — Bulgular

> Koşum tarihi: 2026-07-09 · Soru: "@everyone seçince ajanlar neye göre
> tartışıyor/iş bölüyor? Efektif mi?" — cevap ve düzeltme.

## Önceki durum (efektif DEĞİLDİ)

@everyone ham mesajı her ajana ayrı ayrı yolluyordu; **koordinasyon çerçevesi
yoktu**. Her ajan bağımsız alıp bağımsız cevaplıyordu — tartışma/iş-bölümü şansa
bağlıydı. Mention'sız (lead) rota da lead'e "sen koordinatörsün" demiyordu.

## Yapılan

1. **Koordinasyon zarfı (`src/bus.ts`):** @everyone yayını `[TEAM TASK] ...`
   olarak sarılıyor.
2. **Grup görevi protokolü (`src/protocol.ts`):** her ajanın system prompt'una
   "Group tasks" bölümü — kendi uzmanlığından katkı yap, işi panoyla böl
   (add/claim_task, çift iş yok), kararları protokolle tartış, **lead tek
   birleşik cevabı kullanıcıya versin** (diğerleri lead'e raporlar).
3. **UI:** sağ üstte @everyone toggle butonu; açıkken composer "broadcasting"
   moduna geçer, mesaj `@everyone` prefixiyle gider.

## Canlı doğrulama (`scripts/verify-broadcast.mjs`, kotalı): PASS

@everyone açık, bölünebilir bir grup görevi ("2 maddelik lansman checklist'i,
işi aranızda bölün, birleşik sonuç ver") gönderildi. Gözlem:
- Yayın `[TEAM TASK]` zarfıyla iki ajana gitti.
- **3 ajan-ajan mesajı** — koordinasyon gerçekleşti (herkes ayrı ayrı
  cevaplamadı).
- **Lead (ai-engineer) tek birleşik checklist'i kullanıcıya verdi.**
- Süre ~35 sn.

## Açığa çıkan zayıflık (dürüst not)

Ajanlar panoyu **çakışmadan bölüşemedi**: ikisi de aynı iki işi ayrı ayrı ekledi
(task-1/2 vs task-3/4 — aynı işin çift kaydı). Atomik `claim_task` çift-*iş
yapmayı* önlüyor ama çift-*oluşturmayı* önlemiyor; iki ajan aynı anda `add_task`
çağırırsa kopya görev çıkıyor. Sonucu kurtaran, ajanların bunu fark edip
konuşmasıydı ("we duplicated the board — work didn't collide").

**Sonuç:** Koordinasyon artık gerçek ve efektif (tek birleşik cevap üretiliyor),
ama görev bölüşümü ideal değil. İyileştirme adayları (ileride):
- Yalnızca lead `add_task` çağırsın (worker'lar sadece claim/complete), veya
- `add_task` başlık-bazlı dedup yapsın (aynı başlık zaten varsa yenisini açma).
Bunlar mekanizma düzeyinde çözülür; şimdilik davranış çalışıyor ama not edildi.
