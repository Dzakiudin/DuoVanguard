# HANDOFF — DuoHacker + PRO v4.2 (`duohacker-pro`)

Tool self-hosted lengkap untuk akun Duolingo sendiri. Menggabungkan seluruh fitur backend API + GUI dari **Duolingo DuoHacker V1 v2.6** dan **Duolingo PRO v3.1BETA** ditambah **Duolingo Chess Bot (Vs Oscar & PvP)** ke dalam arsitektur modular Node ESM (`.mjs`), tanpa dependency eksternal, tanpa Docker/VPS.

## Pembuat & Hak Cipta
- **Author**: Dzakiudin / jakijekiiii
- **License**: MIT License © 2026 Dzakiudin (jakijekiiii)

## Status Akun & Verifikasi Terakhir (2026-11-05)
- **Akun**: `JakiJekii` (`jekii`), `sub = 1266919054`, dibuat `2023-09-23`, tz `Asia/Jakarta`, privasi `PUBLIC`, `hasPlus = true`.
- **Course Aktif**: `fromLanguage = id`, `learningLanguage = ja` (tersedia 3 course terdaftar di profil; dapat diganti langsung lewat modal Course Switcher di dashboard).
- **Metrik**: streak **1153** (`lastExtendedDate 2026-11-05`, `doneToday: true`), gems **3485**, `totalXp` **1332733**.
- **Verifikasi End-to-End**:
  - Seluruh modul `.mjs` (termasuk `src/services/chess.mjs`), `userscript/duohacker-pro.user.js` (v4.1.0), dan `<script>` hasil ekstraksi `src/web/dashboard.html` lolos `node --check`.
  - `node autoserver.mjs --verify` & `--status` lolos 100% (dan otomatis membersihkan `duo.alert`).
  - Seluruh endpoint UI (`GET /`, `/duohacker-pro.user.js`, `/api/status`, `/api/verify`, `/api/shop`, `/api/badges`, `/api/league`, `/api/rewards`, `/api/accounts`, `POST /api/chess/analyze`, `POST /api/chess/move`, `POST /api/act/course`, `POST /api/act/rewards/claim-one`) lolos smoke test.

---

## Struktur Folder (Clean Architecture / Separation of Concerns)

```text
D:\#My Project\test
├── src/
│   ├── core/
│   │   ├── client.mjs         # HTTP client, JWT parser, login, failover (www -> android-api), externalApi
│   │   └── config.mjs         # Config/state loader, Multi-Account snapshot manager (tanpa ekspos JWT), duo.alert & duo.log
│   ├── services/
│   │   ├── profile.mjs        # Extended profile (avatar, creationDate, courses, skillId, hasPlus), switchActiveCourse, streakView, privacy, superlink, duome, verifyAccountHealth
│   │   ├── farming.mjs        # 4 Mode XP (Safe +13, Unit Test ~110, Stories +499, Smart Fallback) & 3 Mode Streak (Keeper, Safe Age Backfill, Backfill)
│   │   ├── economy.mjs        # Gems, rewardBundles, claimReward, claimRewards, categorized Shop + Super 3-Day Trial (immersive_subscription)
│   │   ├── quests.mjs         # goals-api client, SAFE_METRICS guard, autoQuests, questLoop, badgesCatalog (Monthly/Daily/Weekly/Friends + Account Age Guard)
│   │   ├── leaderboard.mjs    # Tournament & Default cohort leaderboards, XP gap ke #1, Intelligent Safe XP Limit, Auto-League Farming
│   │   └── chess.mjs          # Full Legal Chess Move Generator + Stockfish NNUE Cloud Hybrid + Local Alpha-Beta Pruning Engine (Piece-Square Tables + Opening Book)
│   └── web/
│       └── dashboard.html     # Unified SPA Dashboard v4.1 (8 Modals termasuk Interactive 8x8 Chess Bot, Course Switcher, Individual Chests Explorer, Lite Mode)
├── userscript/
│   └── duohacker-pro.user.js  # Companion Tampermonkey Userscript v4.1.0 (@grant none Main-World React Fiber & Redux Solver + In-Game Chess Bot Overlay + Fake Duolingo Max)
├── docs/                      # HANDOFF.md + re-findings.md (hasil reverse engineering)
├── duo-core.mjs               # Public Core Facade (re-export semua fungsi core & service untuk kompatibilitas mundur)
├── gems.mjs                   # Public Quests/Economy Facade (re-export semua fungsi quest, badge & economy)
├── autoserver.mjs             # CLI Runner & Scheduled Watchdog
├── ui.mjs                     # Server HTTP + Streaming NDJSON lokal (http://127.0.0.1:8791)
├── start-dashboard.bat        # Launcher 1-klik untuk membuka dashboard web lokal
├── run-streak.bat             # Runner harian Task Scheduler (--verify lalu streak keeper)
└── install-task.ps1           # Installer Windows Task Scheduler (DuoStreak 09:00 WIB)
```

---

## Panduan Penggunaan Cepat

### 1. Menjalankan Dashboard GUI (`http://127.0.0.1:8791`)
Klik dua kali `start-dashboard.bat` atau jalankan `npm start` / `node ui.mjs`, lalu buka `http://127.0.0.1:8791`.
Token UI dibuat sekali, disimpan di `duo.config.state.json` (`uiToken`) dan otomatis di-inject ke halaman. Override dengan env `DUO_UI_TOKEN` bila perlu.

### 2. Memasang Companion Userscript v4.2.0 di Browser (Auto-Solver + Chess Bot)
Saat `ui.mjs` berjalan, klik tombol **🧩 Userscript** di navbar atas dashboard (atau buka `http://127.0.0.1:8791/duohacker-pro.user.js`) dengan ekstensi Tampermonkey aktif.
Fitur di dalam halaman `duolingo.com`:
- **React Fiber & Redux Auto-Solver (`@grant none` Main-World)**:
  - Berjalan langsung di konteks halaman utama (`@grant none`) sehingga properti `__reactFiber$` dan Redux store `store.getState().player` terbaca 100% tanpa diblokir sandbox Tampermonkey.
  - Tombol **`Solve` (`Alt+S`)** dan **`⚡ Solve All` (`Alt+A`)** mendukung seluruh tipe challenge Duolingo (Assist, CharacterSelect, CharacterMatch, CharacterTrace/Kanji SVG path drawing, Translate/TapToken, ListenTap, Match/Pairs, GapFill, ClozeTable, PartialReverse `span[contenteditable]`, dan Stories) serta otomatis melakukan klik 2-tahap (`Check` lalu `Continue`).
- **In-Game Duolingo Chess Bot (Lawan Oscar & Pemain Lain / PvP)**:
  - Mendeteksi state papan catur (`boardFen` & `chessColor`) secara real-time dari Redux (`player.chessPvpMatchState.boardFen`, `player.challengeStates[currentIndex].guess`) maupun React Fiber.
  - Menampilkan **rekomendasi langkah terbaik + Top 5 kandidat** (Stockfish NNUE Cloud `chess-api.com` + fallback Alpha-Beta Engine lokal) beserta **panah hijau SVG & highlight petak langsung di atas papan catur**.
  - Tombol **`♟️ Gerakkan! (Alt+C)`** dan toggle **`🤖 Auto-Gerak saat Giliran`** untuk menjalankan bidak secara otomatis (via React callback + klik/drag-and-drop koordinat papan).

### 3. Perintah CLI (`autoserver.mjs`)
| Perintah | Fungsi |
|---|---|
| `node autoserver.mjs` | Default: jaga streak hari ini (1 sesi jika `doneToday === false`) |
| `node autoserver.mjs --verify` | Cek validitas config, timezone, masa aktif JWT, konektivitas host, dan tulis `duo.alert` jika gagal |
| `node autoserver.mjs --status` | Tampilkan profil lengkap, streak, course, XP, gems, reward, privasi, dan exp JWT |
| `node autoserver.mjs --grant 3 --xp-mode safe` | Jalankan 3 sesi XP (`safe` +13 XP, `unittest` ~110 XP, `story` +499 XP, atau `smart`) |
| `node autoserver.mjs --shop` | Tampilkan katalog shop per kategori |
| `node autoserver.mjs --buy xp_boost_15` | Klaim item gratis (`xp_boost_15`, `immersive_subscription`, `health_shield`, dll.) |
| `node autoserver.mjs --gems` | Klaim reward bundle berisi gems (dibatasi aman oleh `maxClaims`) |
| `node autoserver.mjs --quests` | Preview (DRY) metrik quest harian aktif |
| `node autoserver.mjs --quests --send` | Kirim batch metrik quest harian aman (`SAFE_METRICS`, maks 8 metrik kecuali `--force`) |
| `node autoserver.mjs --badges` | Tampilkan ringkasan Monthly Badges & status umur akun |
| `node autoserver.mjs --badges 05/2026 --send` | Klaim Monthly Badge bulan tertentu (`MM/YYYY`) |
| `node autoserver.mjs --league` | Lihat klasemen Leaderboard minggu ini, jarak XP ke #1, dan batas XP aman |
| `node autoserver.mjs --league --farm` | Auto-farm XP hingga mencapai peringkat #1 di Leaderboard |
| `node autoserver.mjs --privacy private` | Ubah profil menjadi `PRIVATE` (`DISABLE_SOCIAL: true`) atau `PUBLIC` |
| `node autoserver.mjs --superlink <url/id>` | Cek validitas link undangan Family Plan Super |

---

## Aturan Operasional & Keamanan
1. **Jangan pernah** mencetak, me-log, atau menyalin string JWT mentah dari `duo.config.json` / `duo.config.state.json`.
2. `--quests` di CLI selalu **DRY** secara default; pengiriman nyata wajib menyertakan `--send`.
3. Tugas terjadwal harian (`run-streak.bat` / Task Scheduler `DuoStreak` pukul 09:00 WIB) hanya menjalankan `--verify` lalu menjaga streak harian (quest tetap manual).
4. Saat mengedit file `.mjs` di Windows, gunakan Node (`fs.writeFileSync(..., 'utf8')`) atau editor UTF-8 (jangan gunakan `Set-Content -Encoding UTF8` di PowerShell 5.1 agar tidak terjadi mojibake).
