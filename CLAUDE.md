# Quorum — Proje Talimatları

**Önce oku:** [CLAUDE-QUORUM-BRIEF.md](CLAUDE-QUORUM-BRIEF.md) bu projenin tek
referans belgesidir — mimari, karar protokolü, yol haritası (P0-P4) ve tüm
tasarım kararları orada. Bu dosya yalnızca pazarlıksız kısıtları özetler;
çelişki halinde brief kazanır. Mimarinin interaktif görseli: `quorum-mimari.html`.

## Pazarlıksız kısıtlar

1. **Anthropic API KULLANILMAZ.** Her şey kullanıcının Claude aboneliğiyle,
   `claude` CLI üzerinden çalışır. Plan dışı maliyet oluşturan hiçbir şey
   önerme veya ekleme.

2. **ARKA KAPI YASAĞI (brief §3.6).** Her entegrasyon noktası belgeli bir
   arayüz olmak zorunda. İzinli noktalar: `claude --agent <isim>`, stream-json
   programatik mod (giriş/çıkış), init olayındaki `session_id`, `--resume`,
   MCP, Agent SDK (`query()` + `canUseTool` — P0 kararı 2026-07-08: taşıma
   katmanı SDK üzerinden; ham stream-json belgeli yedek yol). YASAK: PTY/TUI otomasyonu, transcript
   dosyası yoklama, isim/açıklama parmak izi eşleştirme, makine-geneli olay
   dinleyip cwd ile filtreleme, doğruluğu hook olaylarına bağlı özellikler
   (hook'lar yalnızca ikincil telemetri olabilir). Durum bilgisi asla çıkarım
   olamaz; kaynak gerçek, sürecin kendi olay akışı + süreç yaşam döngüsüdür.
   **Turnusol:** "Bu bilgiyi nereden biliyoruz?" sorusunun cevabı tahmin,
   yoklama veya eşleştirme içeriyorsa o tasarım reddedilir.

3. **Deneysel agent-teams özelliğine sıfır bağımlılık.** Mesaj taşıma katmanı
   ince ve değiştirilebilir tasarlanır.

4. **Uygulama LLM'e vekillik etmez.** Quorum mesajı taşır ve görselleştirir;
   içerik üretmez, model çağrısı yapmaz.

5. **Kritik kurallar prompt'a değil mekanizmaya.** Tur bütçesi, kuyruklama,
   teslimat garantileri uygulama katmanında yaşar.

## Proje düzeni

- Dil: dahili dokümanlar Türkçe; README ve kod/yorumlar İngilizce (GitHub'da
  yayınlanacak).
- Kalıcı çekirdek `src/` altında TypeScript (Node 25 type stripping ile
  derlemesiz çalışır); birim testleri `test/` (`npm test`), tip kontrolü
  `npm run typecheck`.
- Faz doğrulama script'leri faz klasörlerinde (`p0/`, `p1/` … sade Node .mjs,
  `src/`'yi import eder); bulgular her fazın `BULGULAR.md`'sinde.
- Electron P3'e kadar yok.
- Hedef CLI: kurulu `claude` sürümüne karşı doğrula (bayrak yüzeyi sürümle
  değişebilir); bulguları brief'e/ilgili dokümana işle.
