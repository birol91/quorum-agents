# P2 Bulguları — Karar Katmanı

> Koşum tarihi: 2026-07-08 · Kapsam (brief §9): takım protokolü karar bölümü +
> `record_decision` + kalıcı kararlar dosyası.
> Kod: `src/decisions.ts` (DecisionStore), `src/tools.ts` (record_decision aracı),
> `src/protocol.ts` (kazanan-taraf-kaydeder kuralı).

## Tasarım

- **DecisionStore:** `decisions.jsonl` gerçek kaynak (append-only, makine-okur);
  `decisions.md` her yazımda yeniden üretilen insan-okur görünüm. Sonraki
  oturumlar depoyu diskten yükler (P3 karar paneli doğrudan bu listeyi çizer).
- **`record_decision(topic, decision, rationale)`** in-process quorum sunucusuna
  eklendi; `decidedBy` içerikten değil oturum closure'ından gelir (§3.6).
- **Protokol kuralı:** "Karar kesinleşince pozisyonu kazanan taraf
  record_decision'ı TAM BİR KEZ çağırır; kullanıcı talebini alan ajan sonucu
  kullanıcıya raporlar."

## Doğrulama

**Birim testleri (3/3, toplam 11/11):** kayıt jsonl'e ekleniyor + md render
ediliyor; aynı dizinde açılan yeni depo kayıtları geri yüklüyor; çoklu karar
sıralı render ediliyor.

**Canlı smoke (`p2/smoke-decision.mjs`, sonnet): GEÇTİ — 102 sn, ilk koşuda.**
Yol haritası ölçütü birebir: çatışmalı soru (pgvector vs Pinecone) verildi,
ajanlar kendi başına karara vardı, karar kalıcı kayda geçti:
- 8 çift mesajı; karşılıklı KABUL; eskalasyon bu koşuda gerekmedi (bağlam
  kickoff'ta yeterliydi).
- ai-engineer protokolü kendisi uyguladı: "senin pozisyonun kazandı,
  record_decision'ı sen çağır" diye kazanan tarafa devretti.
- Kayıt: data-engineer → "Vector store: pgvector vs Pinecone" → dedicated
  Postgres + pgvector (HNSW), tanımlı tetikleyicilerle Pinecone fallback.
  Kalıcılık, deponun diskten yeniden yüklenmesiyle doğrulandı.
- Token: A 5 turda ~4.0k çıktı, B 4 turda ~3.9k çıktı.

## Gözlemler

- **Çift kullanıcı raporu:** Karar sonrası İKİ ajan da kullanıcıya rapor gönderdi
  (protokol tek ajana atamıştı). Zararsız ama gürültü; P3 toplantı odası
  görünümünde aynı karara bağlı mesajlar gruplanmalı ya da protokol netleştirilmeli.
- **Bütçe zinciri sıfırlaması sahada doğrulandı:** 8. çift mesajından önce
  data-engineer kullanıcıya rapor attığı için zincir sıfırlandı ve not (doğru
  şekilde) tetiklenmedi — P1 mekanizması müzakere akışında beklendiği gibi davrandı.
- P1'de kaydedilen haiku "sessiz tur" pürüzü bu sonnet koşusunda görülmedi.
