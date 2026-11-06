# Lead Delegasyonu (LEAD BRIEF) — Bulgular

> Koşum tarihi: 2026-07-09 · Soru: "Lead'e düz iş verince gerçekten böler ve
> ajanlar birlikte en kaliteli sonucu çıkarır mı?"

## Önceki durum

Düz (mention'suz/seçimsiz) mesaj lead'e gidiyordu ama koordinasyon çerçevesi
yoktu; grup-görevi protokolü sadece `[TEAM TASK]` etiketiyle (yayın/seçim)
tetikleniyordu. Lead'in "bölеyim mi?" refleksi düz işte **sistematik tetiklenmiyordu**
— tamamen modelin inisiyatifindeydi.

## Yapılan

- **`src/bus.ts leadBrief()`:** Düz lead mesajı artık `[LEAD BRIEF]` çerçevesiyle
  sarılıyor — çerçeve ekibi (isim + uzmanlık) listeler ve lead'e "basitse kendin
  yap, çok-uzmanlıklıysa böl (panoyu kullan), sonucu tek birleşik cevap olarak ver"
  der. Bölmeyi ZORLAMAZ; lead karar verir.
- **`src/protocol.ts`:** system prompt'a "If you are the lead" bölümü eklendi.

## Canlı smoke (`p5/smoke-lead-split.mjs`, 3 sonnet ajanı): LEAD-SPLIT PASS

Takım: ai-engineer (lead) + data-engineer + prompt-engineer. Düz iş:
"RAG'li destek chatbot'u için kısa teknik plan — retrieval, AI/orkestrasyon,
prompt stratejisi." Sonuç (~55 sn):
- Lead işi böldü: data-engineer → retrieval/veri katmanı (task-1),
  prompt-engineer → prompt stratejisi (task-2). Panoda 3 görev.
- İki teammate de kendi uzmanlığından katkı yaptı ve lead'e döndü.
- Lead piece'leri topladı ve **tek birleşik, 3-katmanlı kaliteli planı** kullanıcıya
  verdi. `replies to user: 1, from lead: true`.

**Sonuç:** Lead delegasyonu artık düz işte de mekanizmayla tetikleniyor; "en
kaliteli tek cevap" akışı canlı doğrulandı. (Not: tek koşu; kalite yine modele
bağlı — mekanizma delegasyonu teşvik eder, garanti etmez.)
