# MangaLens Browser (Android)

Browser Android berbasis WebView dengan:

1. **Anti iklan** – blokir request ke jaringan iklan (daftar host + pola URL), blokir **pop-up / pop-under / redirect iklan**, sembunyikan slot iklan umum, hapus overlay transparan penangkap klik. Bisa dimatikan per situs (ikon perisai) dan daftar filter bisa diperbarui dari menu.
2. **Penerjemah gambar** – port dari ekstensi *MangaLens* (OCR → inpainting → terjemah Gemini → tempel teks). Kode JS ekstensi dipakai ulang; panggilan Gemini & unduh gambar dijalankan di sisi native.

## Cara build
**Android Studio** (disarankan): *File → Open* folder ini → tunggu Gradle sync → *Run* ke HP (Android 10+, minSdk 29).
**Tanpa Android Studio**: push folder ini ke repo GitHub → tab *Actions* → *Build APK* → unduh artifact `app-debug.apk`.

## Pakai
1. Menu (⋮) → **Pengaturan MangaLens** → isi **API key Gemini** → *Tes koneksi*.
2. Buka halaman manga/manhwa/manhua → ikon terjemah di bar bawah = terjemahkan semua gambar. Ketuk gambar → tombol terjemah muncul di pojok gambar. Tekan lama gambar → "Terjemahkan gambar ini". Tombol **MangaLens** di pojok kanan bawah halaman = menu lengkap.
3. Perisai di bar atas = nyalakan/matikan anti iklan untuk situs yang sedang dibuka.

## Struktur
- `app/src/main/java/.../MainActivity.kt` – UI browser, pemblokir pop-up/redirect, intersepsi request.
- `AdBlocker.kt` – daftar host & pola; `assets/adblock/` – daftar bawaan; `assets/ml/adblock.js` – skrip anti-iklan sisi halaman.
- `TranslateBridge.kt` – jembatan JS↔native (token acak, hanya frame utama, API key tidak pernah dikirim ke halaman).
- `GeminiClient.kt`, `Prompts.kt`, `ImageFetcher.kt` – port `background.js` / `shared.js`.
- `assets/ml/bundle.js` – hasil rakitan skrip ekstensi + shim `chrome.*` (dibuat dengan `build_assets.py` dari zip asli; dengan patch sentuh/simpan file).
- `assets/mangalens/` – halaman pengaturan asli ekstensi.

## Batasan yang perlu diketahui
- Belum dikompilasi/diuji di perangkat saat dibuat; kemungkinan ada perbaikan kecil saat build pertama.
- Iklan video dalam pemutar (mis. YouTube) tidak diblokir; pemblokiran berbasis daftar host, bukan EasyList penuh.
- Ekspor pengaturan (tombol unduh di halaman pengaturan) belum bisa menyimpan file di WebView.
- Hanya satu tab. Butuh Android System WebView yang cukup baru.
- API key disimpan di penyimpanan privat aplikasi (belum dienkripsi).
