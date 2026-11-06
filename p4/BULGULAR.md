# P4 Bulguları — Desenler & Görev Panosu

> Koşum tarihi: 2026-07-09 · Kapsam (brief §9 P4): paylaşımlı görev panosu
> (`claim_task`/`complete_task`), koordinatör deseni.

## Ne kuruldu

- **`src/tasks.ts` — TaskBoard:** `DecisionStore` disipliniyle; `tasks.jsonl`
  append-log (durum anlık görüntüleri, id başına son-yazan-kazanır ile geri
  yükleme), `tasks.md` insan-okur görünüm. `addTask` deterministik `task-${n}`
  id (saat/rastgele yok). **`claimTask` atomik:** yalnızca `open` iken sahiplenir;
  başkası aldıysa `already-claimed-by-<name>`. `completeTask` yalnızca claimer
  tarafından ve yalnızca `claimed` görevde.
- **Araçlar (`src/tools.ts`, `opts.taskBoard` ardında):** `add_task`,
  `claim_task`, `complete_task`, `list_tasks`. Kimlik (`createdBy`/claimer)
  closure'dan gelir, içerikten değil (§3.6).
- **Manager hookup:** `QuorumManager` TaskBoard'ı `.quorum` altında kurar ve her
  oturuma verir.

## Doğrulama

**Birim testleri (5 yeni, toplam 16/16 yeşil):** ekle→open; A sahiplenir, B'nin
ikinci sahiplenmesi `already-claimed`; claimer olmayan `not-your-task`, claimer
tamamlar; diskten geri yükleme durumları koruyarak; olmayan id `no-such-task`.

**Canlı koordinatör smoke (`p4/smoke-coordinator.mjs`, 3 haiku ajanı): GEÇTİ.**
Koordinatör işi iki bağımsız göreve böldü ve worker'lara panoyu kontrol
etmelerini söyledi. Sonuç:
```
task-1 [done] "Write launch copy"   by=worker-b
task-2 [done] "Pick a launch date"  by=worker-a
```
**İki görev iki FARKLI worker tarafından sahiplenildi — çift iş yok.** Atomik
claim'in tüm amacı (brief §12'nin "iş tekrarı" maliyeti) sahada doğrulandı.
8 bus mesajı, tam otonom akış.

## Not (spec sapması, additive)

`completeTask` `open` (sahiplenilmemiş) bir göreve çağrılırsa `not-claimed`
reason'ı döner — spec bu durumu adlandırmamıştı; zararsız ek. `add_task` aracı
spec'in v2 listesinde yoktu ama koordinatör deseninin işi bölebilmesi için
gerekliydi; eklendi.

## esm-import bağımlılığı

TaskBoard araçları `quorumServerFor` üzerinden geldiği için, P3.2'de çözülen
`src/esm-import.ts` düzeltmesi (tsc'nin `import()`'u `require()`'a çevirmesini
engelleme) P4'ün Electron altında çalışması için de gerekliydi.
