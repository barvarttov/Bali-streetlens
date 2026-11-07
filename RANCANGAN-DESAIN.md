# Bali StreetLens: Rancangan Lengkap Desain & Aplikasi

Versi 2, 3 November 2026 (tampilan Lembar Rupabumi, mode terang saja, arah U/T/S/B, peta seluruh Bali). Ini dokumen rancangan utama. Isinya: produknya apa, untuk siapa, tampilannya seperti apa, layar dan fiturnya apa saja, dan aturan desainnya.
Ini satu-satunya file desain. Kode aplikasinya ada di folder yang sama (`web/`, `backend/`, `config/`).
Semua angka contoh (23 kendaraan, 14 menit, dan sebagainya) hanya ilustrasi, bukan hasil pengukuran.

---

## 1. Produknya apa

**Peta 3D Bali yang dipakai seperti Google Maps**: bisa digeser, di-zoom, dimiringkan, dan diputar.
Di simpang yang punya CCTV pemerintah (peta CCTV Bali Satu Data, 91 kamera), peta itu "hidup". Motor, mobil, bus, dan truk terlihat bergerak di simpang **secara langsung**, sebagai bentuk 3D anonim. Pengguna bisa mencari **rute dari A ke B** dengan sampai tiga pilihan, dan rute yang disarankan memutari simpang yang sedang macet.

- **Video CCTV mentah tidak pernah ditampilkan ke publik.** Kamera hanya jadi masukan; yang tampil adalah adegan 3D tanpa wajah dan tanpa plat nomor.
- **Bahasa:** Bahasa Indonesia sebagai bawaan, ada tombol ganti ke Inggris.
- **Perangkat:** utamanya HP. Di laptop, panel pindah ke sisi kiri.
- **Peta seluruh Bali** bisa dibuka sampai detail 3D, termasuk Bali utara (Singaraja, Kintamani), tanpa internet setelah `npm run tiles`.
- **Area demo:** koridor bandara di Bali selatan, dengan 6 simpang:
  - Simpang Patung Kuda
  - Underpass Ngurah Rai
  - Simpang Kedonganan
  - Simpang UNUD
  - Simpang Taman Griya
  - Simpang Pintu Tol

| | |
|---|---|
| **Pengguna** | Warga Bali (kebanyakan naik motor) dan wisatawan (motor sewaan, mobil sewa, ojek online, dari hotel) |
| **Pertanyaan mereka** | "Simpang yang mau saya lewati lancar atau tidak? Kalau macet, lewat mana?" |
| **Ukuran sukses** | Jawabannya terlihat dalam ±3 detik, dan alasannya bisa dibuka dengan satu ketukan |
| **Juri** | Melihatnya sebagai produk publik ini (penjurian tatap muka, ±9 November 2026) |

### Prinsip produk
1. **Sekali lihat, langsung paham.** Status simpang muncul paling dulu.
2. **Jangan pura-pura langsung.** Setiap angka menyebut kesegarannya. Kamera offline dan rekaman ditulis jujur.
3. **Lihat lalu lintasnya, bukan orangnya.** Adegan 3D anonim. Tidak ada plat, wajah, atau identitas (sesuai UU PDP 27/2022).
4. **Motor dulu.** Lalu lintas Bali kebanyakan motor, jadi hitungan dan tampilan mengutamakan motor.
5. **Setiap label ada buktinya.** Label "Macet" bisa dibuka untuk melihat angka di baliknya. Akurasi diukur dengan hitungan manual, tidak diklaim.

---

## 2. Tampilan: "Lembar Rupabumi" (hanya mode terang)

**Gagasan utama:** peta dan kartunya terbaca sebagai **satu lembar peta resmi** seperti Peta Rupabumi Indonesia. Kertasnya putih, tintanya hijau zaitun (`#606C38`, sejak 2026-11-04; sebelumnya hitam), garisnya 1 piksel, dan tidak ada sudut membulat. Kartu kiri berperan sebagai **margin lembar peta**, berisi judul, daftar simpang, dan keterangan.

Dipilih pengguna lewat halaman pilihan arah (2026-11-03, setelah satu kali undi ulang). Ini menggantikan "Nawa Sanga Neo", yang oleh pengguna dinilai "AI slop": terlalu banyak pil dan kartu membulat, badge berpendar, dan tampilan gelap ala dashboard.

**Hanya mode terang.** Tombol siang/malam dihapus (keputusan pengguna 2026-11-03: "bukan hal yang berguna"). Alasan pemakaiannya: aplikasi dipakai di jalan di bawah matahari Bali, dan didemokan di laptop atau proyektor.

**Ciri khas lembar peta:**
- Peta berada di dalam **bingkai garis hitam 1px** dengan margin putih.
- Di tepi atas dan kanan ada **angka koordinat (BT/LS)** yang ikut bergeser saat peta digeser.
- Di kanan bawah ada **batang skala hitam-putih** dan **keterangan**.
- Di HP bingkainya tidak ada; koordinat hanya tampil di tepi kanan.
- **Peta berwarna** (permintaan pengguna 2026-11-04: "lebih berwarna", "semakin dalam laut, semakin pekat birunya").
  - Laut diwarnai menurut **kedalaman sebenarnya**: data batimetri Natural Earth 1:10m (domain publik), `web/public/bathymetry.json`, dibuat dengan `npm run bathymetry`. Biru muda di pantai, makin pekat ke Laut Bali, Selat Lombok, dan Samudra Hindia.
  - Daratan krem hangat, hutan hijau, sawah hijau-kuning, pantai pasir, kota krem, danau biru. Semua warna daratan tetap muda, jadi hijau/kuning/merah status di ruas yang dipantau tetap paling menonjol.
  - Kawasan lindung (Taman Nasional Bali Barat, kawasan konservasi laut Nusa Penida) digambar sebagai garis putus-putus, bukan blok hijau, karena batasnya menjorok ke laut.
- **Hanya Bali yang terlihat** (permintaan pengguna 2026-11-03).
  - Semua daratan di luar batas Provinsi Bali (Java, Lombok) dicat sewarna laut, dan nama tempat di luar Bali disembunyikan. Nusa Penida tetap tampil.
  - Zoom out berhenti saat seluruh pulau pas di layar, dan peta tidak bisa digeser keluar dari area itu. Batasnya dihitung ulang mengikuti ukuran layar.
  - Batas provinsi diambil dari OpenStreetMap (`web/src/public/bali-outline.json`, dibuat dengan `npm run outline`).

### 2.1 Warna

| Arti | Warna | Teks di atas putih | Dipakai untuk |
|---|---|---|---|
| **Lancar** | `#1F8A55` | `#16683F` | Ruas lancar, tanda cincin, kata LANCAR |
| **Padat** | `#E8A317` | `#8A5A00` | Ruas padat, tanda setengah, kata PADAT |
| **Macet** | `#D23B2E` | `#B0281D` | Ruas macet, tanda penuh dengan halo pelan, kata MACET |
| Tanpa data | `#9AA3A9` | `#4E555B` | Tanda cincin putus-putus |
| **Tinta zaitun** (pilihanmu, aksi utama, semua garis dan kotak) | `#606C38` | putih di atasnya 5,7:1; di atas laut dan hutan ≥ 4,5:1 | Bingkai, garis kotak, tombol utama, simpang dan rute terpilih, papan arah, tombol aktif, lokasimu. Pengganti hitam (keputusan pengguna 2026-11-04; sempat marun `#540B0E`) |
| Teks | `#15181B` | 17,6:1 | Semua tulisan tetap hampir hitam supaya mudah dibaca |
| **Pita kartu** (kepala kartu dan panel Tanya, bukan status) | `#606C38` | teks putih dan `#EEF1E1` (4,95:1) | Pita judul kartu kiri, panel bawah HP beserta pegangannya, dan kepala panel Tanya |

**Permukaan:**

| Token | Warna |
|---|---|
| Kertas (kartu, kotak) | `#FFFFFF` |
| Daratan | `#FBF8F0` (krem hangat) |
| Laut dangkal 0–200 m | `#A9D8F2` |
| Laut makin dalam: 200 / 1.000 / 2.000 / 3.000 / 4.000 m | `#86C5EC` / `#61A9DE` / `#448ECD` / `#3075B9` / `#225DA0` |
| Danau, sungai | `#8ECAEE` |
| Hutan / taman | `#BEDFA8` |
| Sawah / kebun | `#DDEDB9` |
| Pantai pasir | `#F4E2AE` |
| Kota | `#F1E9DC` |
| Batas taman nasional / kawasan konservasi laut | garis putus-putus `#6E9E58` |
| Garis tipis | `#D5D9DC` |
| Teks utama | `#15181B` |
| Teks kedua | `#4E555B` |

**Aturan warna:**
1. Hijau, kuning, dan merah **hanya** untuk status lalu lintas, dan **hanya** di ruas yang benar-benar dilihat kamera.
2. Tidak ada biru aksen. Zaitun `#606C38` adalah satu-satunya tinta untuk garis, kotak, "kamu dan aksimu", dan pita kepala kartu. Teks tetap hampir hitam. Zaitun tidak pernah dipakai sebagai status; lancar tetap hijau `#1F8A55` dengan tanda cincin dan kata LANCAR.
3. **Status tidak pernah hanya warna.** Selalu ada **tanda** (cincin / setengah / penuh / putus-putus) dan **kata**.
4. Dari dekat (zoom ≥ 15), ruas yang dipantau digambar **selebar jalan aslinya dalam meter**: pita berwarna muda sesuai status, dengan tepi berwarna status. Kendaraan 3D berjalan di atas pita itu.
5. Semua teks lolos WCAG AA (≥ 4,5:1); tesnya ada di `palette.test.ts`.
6. **Satu sumber warna:** `web/src/lib/palette.ts` (peta MapLibre dan Three.js). `web/src/styles/tokens.css` adalah cerminannya untuk CSS.

### 2.2 Arah
- Arah memakai **mata angin biasa**: utara, timur laut, timur, tenggara, selatan, barat daya, barat, barat laut (EN: north … northwest). Huruf di papan dan kartu: **U, TL, T, TG, S, BD, B, BL** (EN: N, NE, E, SE, S, SW, W, NW).
- Keputusan pengguna 2026-11-03: kaja/kelod/kangin/kauh dan Kompas Nawa Sanga diganti dengan U/T/S/B biasa.
- Arah datang disebut dari arah asal kendaraannya. Contoh: "Antre 14 mnt dari selatan".
- Peta menghadap utara. Tombol utara (jarum hitam-putih) ikut berputar bersama peta; ketuk untuk menghadap utara lagi.
- Id arah di data (`kaja`, `kelod`, …) tetap dipakai sebagai kunci data saja, tidak pernah ditampilkan.

### 2.3 Huruf
- **Archivo** (variabel, dengan sumbu lebar) dipasang sendiri di aplikasi, jadi tetap jalan tanpa internet. Dipakai juga untuk label di peta.
- Nama tempat di peta ditulis huruf kapital berjarak, seperti peta cetak.
- Judul tebal 900. Kata status ditulis kapital sempit (lebar 78–88%). Label bagian ditulis kapital lebar berjarak.
- Angka tabular, jadi tidak bergeser saat berubah.

### 2.4 Bentuk dan jarak
- **Tanpa sudut membulat.** Semua kotak bergaris 1px hitam, dengan bayangan lembut hanya untuk kotak yang melayang di atas peta.
- Satu ritme jarak: kelipatan 4px. Target sentuh 44px di desktop, 48px di HP.
- **Satu angka hanya tampil di satu tempat.**
- Ikon: Phosphor (tebal). **Tanpa emoji.**

### 2.5 Status: tanda + kata + warna

| Status | Tanda di peta dan kartu | Kata |
|---|---|---|
| **Lancar** | cincin hijau ○ | LANCAR (hijau tua) |
| **Padat** | setengah terisi ◐ kuning | PADAT (cokelat-kuning) |
| **Macet** | penuh ● merah, dengan halo yang berdenyut pelan | MACET (merah tua) |
| **Tanpa data** | cincin putus-putus | TANPA DATA |

- **Ukuran tanda** mengikuti volume kendaraan per menit (22 / 28 / 34 px).
- Nama simpang ditulis di samping tanda seperti huruf peta (kapital, halo putih), **tanpa pil**.
- Dari jauh (zoom < 11,6), enam simpang menjadi satu tanda kelompok "KORIDOR BANDARA 6". Tanda itu memakai status terparah, dan bisa diketuk.

### 2.6 Indikator di kartu simpang
- **Kata status besar** (MACET) dan satu kalimat jawaban: "Antre 14 mnt dari selatan".
- **Arah datang:** huruf arah dalam kotak, lalu "dari selatan", **batang yang panjangnya sama dengan lama antrean** (penuh = 20 menit), fakta singkat, dan kata status.
- **30 menit terakhir:** 30 kotak bergaris, satu per menit. Kotak tanpa data diarsir.
- **Kendaraan 15 menit:** satu batang proporsional (motor paling kiri) dengan angka di bawahnya, dalam warna abu netral, karena jenis kendaraan tidak pernah memakai warna status.
- Catatan kecil di kaki kartu: kendaraan 3D adalah ilustrasi, dan akurasi belum diukur.

### 2.7 Warna di peta 3D (Three.js)

| Benda 3D | Warna | Aturan |
|---|---|---|
| Kendaraan bergerak | grafit `#2B3238` | Selalu kontras dengan jalan |
| Berhenti dalam antrean padat | `#E8A317` | Antrean terlihat sebagai "ekor" berwarna |
| Berhenti dalam antrean macet | `#D23B2E` | Sama |
| Saat kamera "Terlambat" (data > 10 dtk) | `#AEB5BA` | Tidak pura-pura segar |
| Cahaya | langit putih, satu matahari | **Tanpa bayangan di HP** |

- Jenis kendaraan dibedakan dari bentuk dan ukuran: motor, mobil, bus, truk.
- **Kendaraan tetap di jalan.** Lebar lajur dihitung dari jumlah lajur OSM (3,1 m per lajur, bawaan 2 lajur), dan peta menggambar ruas yang dipantau dengan lebar yang sama dalam meter. Dulu jalan digambar dalam piksel dan berhenti membesar setelah zoom 18, sehingga kendaraan tampak menembus tepi jalan. Tes `traffic3d.test.ts` mensyaratkan ≥ 90% posisi kendaraan di aspal; hasil saat ini **97,9%**.

### 2.8 Gerak
| Saat | Gerak | Untuk yang memilih "kurangi gerakan" |
|---|---|---|
| Memilih tempat atau simpang | Kamera terbang (900 ms), sisa peta memudar ke putih | Langsung pindah |
| Kartu muncul | Kartu terbuka dari kiri (260 ms) | Langsung |
| Kendaraan langsung | Posisi mengalir halus di antara pembaruan data | Tetap bergerak (karena ini data) |
| Status berubah | Satu denyut cincin hitam yang tidak berulang | Hanya berganti |
| Simpang macet | Halo merah berdenyut pelan (2,4 dtk). Satu-satunya gerak berulang | Diam |
| Data langsung | Titik hijau "Langsung" berdenyut | Diam |
| Tombol utara | Ikut putaran peta 1:1 | Sama |
| Panel bawah (HP) | Mengikuti jari, lalu berhenti di salah satu dari 3 posisi | Langsung berhenti |

---

## 3. Peta layar (alamat halaman)

```
/                          Peta: peta 3D + daftar simpang koridor        (publik)
/simpang/<id>              Simpang: tampilan langsung satu simpang       (publik, bisa dibagikan)
/simpang/<id>/kenapa       Kenapa: alasan di balik label                 (publik)
/rute                      Rute: dari A ke B, sampai 3 pilihan            (publik)
/kamera/<id>               Kamera provinsi: kalau sedang menyala, hitungan AGA di kartu
                           dan kendaraannya digambar 3D di peta utama     (publik, bisa dibagikan)
/langsung[/<id>]           Alamat lama, dialihkan ke / atau /kamera/<id>
/tim                       Alat tim: pemutar analisis, penghitung manual, kalibrasi
```

Setiap simpang punya tautan sendiri. Orang Bali saling berbagi info macet lewat grup WhatsApp, dan tombol **Bagikan** menghasilkan tautan yang langsung membuka simpang itu.

---

## 4. Layar publik (dirancang untuk HP)

### 4.1 Peta (beranda)
Alur yang diminta pengguna (2026-11-03): **lihat peta secara garis besar dulu → kotak cari di kiri atas bertanya "Mau ke mana?" → setelah mencari, peta zoom ke daerah itu → kartu muncul di kiri.**
- **Pertama dibuka:** seluruh pulau Bali, menghadap utara, tanpa kartu. Keenam simpang tampil sebagai satu tanda kelompok "KORIDOR BANDARA 6".
- **Kiri atas:** kotak "Mau ke mana?" dengan tombol **RUTE** dan ID | EN di dalamnya. RUTE membuka perencana rute (§4.5).
  - Saat diketuk tanpa diketik, kotak ini langsung menampilkan daftar simpang dipantau dari yang paling parah. Daftar ini juga jalan masuk tanpa peta, untuk aksesibilitas.
  - Saat diketik, kotak ini mencari **1.670 tempat se-Bali** (kota, desa, kawasan, pantai, wisata, gunung, danau, pasar, bandara) dari OpenStreetMap (`web/public/places.json`, dibuat dengan `npm run places`).
- **Setelah memilih tempat:** peta terbang ke sana dan kartu "area" muncul, dengan tombol utama **Rute ke sini**.
  - Ada simpang dipantau dalam 6 km: kartu menampilkan daftar simpang itu dari yang paling parah.
  - Tidak ada: kartu menulis jujur "Belum ada simpang yang dipantau di sini", lalu menampilkan simpang dipantau terdekat beserta jaraknya, dan jumlah kamera provinsi di sekitar.
- **Kanan atas:** satu kolom tombol bergaris: utara, 3D/2D, Lokasi saya, perbesar/perkecil (di HP tanpa +/−, karena bisa pinch). Izin lokasi baru diminta saat tombol diketuk.
- **Kanan bawah:** keterangan tanda (Lancar, Padat, Macet, Tanpa data), pilihan **Kamera provinsi** (menampilkan 85 kamera lain sebagai titik "belum dianalisis"), dan batang skala.
- Chip "Koridor Bandara / Padat & macet / Semua kamera" dihapus. Daftar sudah urut dari yang paling parah, dan kamera ada di keterangan.

### 4.2 Simpang (tampilan langsung)
- **Peta:**
  - Terbang mendekat ke simpang (miring 58°).
  - Sisa peta meredup halus.
  - **Kendaraan 3D bergerak langsung**: bentuk sederhana dan anonim untuk motor, mobil, bus, truk.
    - Digambar dengan Three.js di dalam peta, di atas jalur OpenStreetMap asli. Arah satu-arah dan jumlah lajur diambil dari OSM, dan kendaraan berjalan di kiri.
    - **Sekarang:** kendaraan adalah ilustrasi dari angka langsung, yaitu antrean, arus, dan campuran jenis kendaraan. Antrean yang terlihat sama besarnya dengan jumlah kendaraan berhenti dari data. Panel menulis jujur: "Kendaraan 3D adalah ilustrasi … Bukan posisi kendaraan sebenarnya."
    - **Nanti:** kalau kamera sudah mengirim posisi kendaraan (setelah kalibrasi Person B), lapisan yang sama menggambar posisi asli, dan kalimat ilustrasi itu hilang.
  - Papan arah hitam U/T/S/B di setiap ujung jalan.
  - Panjang antrean diwarnai di jalurnya.
- **Panel, setengah layar:**
  1. Nama simpang (aksara Bali di atasnya kalau sudah dicek) dan nama jalannya.
  2. Label status dan **kesegaran data**, misalnya "Langsung · 3 dtk lalu".
  3. **Daftar arah datang** sesuai urutan kompas. Contoh: `S · dari selatan · ▬▬▬ · antre 14 mnt · MACET`.
  4. **Strip 30 menit terakhir:** 30 kotak, satu per menit, berwarna putih, kuning, atau merah, dan bergaris kalau tidak ada data.
  5. Tombol **Kenapa macet?**, **Rute ke sini**, dan **Bagikan**.
- **Panel, layar penuh:**
  - kendaraan 15 menit terakhir per jenis (**motor paling atas**)
  - arus per arah
  - **"Seberapa akurat?"**: hasil uji akurasi kamera ini. Kalau belum diukur, tertulis jujur "Belum diukur".

### 4.3 Kenapa? (bukti di balik label)
- **Kalimat penjelasan.** Contoh: "Macet karena 23 kendaraan berhenti lebih dari 10 detik dari arah kelod selama 14 menit, sementara kendaraan lain tetap lewat garis henti. Ini antrean yang bertahan, bukan lampu merah."
- **Tabel tiga aturan yang benar-benar menentukan label:**

| | Sekarang | Aturan |
|---|---|---|
| Kendaraan berhenti lebih dari 10 dtk | 23 | ≥ 5 kendaraan berarti antrean |
| Antrean bertahan | 14 mnt | ≥ 30 dtk berarti macet |
| Lewat garis henti | 6/mnt | > 0 berarti antrean, bukan lampu merah |

- **Cara membaca lampu:** disimpulkan dari arus kendaraan, karena lampu lalu lintas tidak terlihat kamera.
- **Sumber:** CCTV Bali Satu Data, Diskominfos Provinsi Bali. Selama datanya masih sintetis, tertulis "data sintetis".

### 4.4 Putar ulang 30 menit (Hari 4)
- Satu penggeser waktu menggerakkan semuanya bersamaan: kendaraan 3D, semua penanda, strip, dan angka.
- Selama tidak langsung, ada bar hitam **"PUTAR ULANG · 13:52 WITA"** dengan tombol **Kembali ke langsung**. Rekaman tidak bisa tertukar dengan siaran langsung.

### 4.5 Rute (dari A ke B)
Keputusan pengguna 2026-11-03: rute seperti Google Maps, dengan banyak pilihan yang bisa dipilih. Ini menggantikan rencana "Jalan memutar" per simpang (U/T/S/B), karena jalan memutar hanyalah rute yang menghindari simpang macet.

1. **Masuk:** tombol **RUTE** di kotak cari, **Rute ke sini** di kartu tempat, atau **Rute ke sini** di kartu simpang. Alamatnya `/rute`.
2. **Kotak Dari / Ke** menggantikan kotak cari, dalam satu kotak bergaris. Titik awal ditandai cincin, tujuan ditandai kotak hitam, dan keduanya disambung garis titik-titik (sama seperti di peta). Di kanan ada tombol tutup dan tukar.
   - Saat kotak diketuk tanpa diketik: **Lokasi saya**, **Pilih di peta**, lalu simpang dipantau.
   - Saat diketik: tempat dan simpang yang sama dengan "Mau ke mana?".
   - Izin lokasi tetap baru diminta saat **Lokasi saya** diketuk. Di HP, kalau titik awal belum ada, keyboard tidak dibuka paksa: kartu menampilkan tombol besar **Pakai lokasi saya** dan **Pilih di peta**.
3. **Pilih di peta:** kartu dan tombol peta disembunyikan, pin tetap di tengah, dan pengguna menggeser peta di bawahnya. Bar hitam di atas menulis "Geser peta sampai pin ada di tujuan" dengan tombol **Batal**, dan tombol **Pakai titik ini** ada di bawah. Titiknya diberi nama "Titik dekat Kuta" dari tempat terdekat.
4. **Kartu rute:** sampai **3 pilihan, A, B, C**, urut dari yang disarankan.
   - Tiap baris: huruf dalam kotak, **"lewat Jl. …"** (jalan yang membedakannya dari rute lain), jarak, lalu simpang dipantau yang dilewati beserta status langsungnya, atau "Tidak lewat simpang yang dipantau".
   - Rute A diberi label **DISARANKAN**, dengan alasannya kalau ada, misalnya "menghindari macet di Patung Kuda".
   - Baris terpilih: latar abu muda, garis hitam di kiri, huruf putih di kotak hitam.
   - Di bawah daftar: simpang dipantau di rute terpilih, berurutan, dengan arah masuknya ("masuk dari selatan") dan statusnya. Lalu jalan utamanya, dan tombol utama **Buka di Google Maps**.
   - Kalau status simpang di rute berubah setelah rute dihitung, muncul pita kuning "Status simpang di rute ini berubah" dengan tombol **Hitung ulang**. Rute tidak diurut ulang sendiri saat sedang dibaca.
   - Saat mencari: tiga baris kerangka yang berdenyut. Saat gagal: alasan yang jujur (misalnya ke Nusa Penida perlu kapal) dan langkah berikutnya.
5. **Peta:**
   - Rute terpilih: garis **hitam** tebal bertepi putih (hitam = pilihanmu). Rute lain: abu-abu, bisa diketuk untuk memilihnya.
   - Papan kecil di tiap rute, "A · 8,4 km", di bagian rute yang tidak berimpit dengan rute lain. Papan rute terpilih hitam, yang lain putih.
   - Ruas yang dipantau tetap digambar di atas rute dengan warna statusnya, jadi macet di rute langsung terlihat.
   - Kalau titik yang dipilih jauh dari jalan, garis titik-titik menyambungkannya ke jalan terdekat.
6. **Tidak ada klaim waktu tempuh** sebelum diukur: kartu hanya menulis jarak. Waktu dipakai di dalam untuk mengurutkan jalan saja.
7. **Buka di Google Maps** membawa titik awal, tujuan, dan dua titik di tengah rute, supaya Google mengikuti rute yang dipilih. Kami menyarankan, Google yang memandu belokan demi belokan.

**Cara kerjanya:**
- Jaringan jalan seluruh Provinsi Bali dari OpenStreetMap (motorway sampai jalan permukiman; tanpa jalan servis dan jalan tanah), disimpan sebagai graf ringkas di `config/roads.json.gz` (`npm run roads`). Tidak butuh internet saat demo.
- Backend mencari rute dengan A* di `backend/routing.py` (`GET /api/route?from=lng,lat&to=lng,lat`). Bobotnya perkiraan waktu per kelas jalan.
- Masuk simpang dipantau dari arah yang **macet** ditambah 7 menit, dari arah **padat** 2 menit, jadi rute A cenderung memutar.
- Pilihan B dan C: jalan rute yang sudah ketemu dibuat lebih mahal, lalu dicari lagi. Rute baru dipakai kalau minimal 28% berbeda dan tidak lebih dari 1,45 kali rute A.

### 4.6 Cari
- Mencari nama simpang (tahan salah ketik dan singkatan: "ptg kuda" menemukan Patung Kuda) dan tempat (Bandara, Kuta, Jimbaran, Nusa Dua).
- Hasilnya langsung menampilkan label status.

### 4.7 Menu
- Bahasa (ID/EN), di dalam kotak cari
- **Tentang data & privasi** (belum dibuat)
- Tidak ada pilihan tema: aplikasi hanya memakai mode terang.

### 4.8 Tanya lalu lintas (asisten AI, gratis)
Keputusan pengguna 2026-11-04: chatbot di kanan untuk bertanya soal daerah yang padat hari ini. **Wajib gratis**: tidak boleh ada layanan berbayar.

- **Masuk:** tombol hitam **TANYA** di bawah kolom tombol peta.
  - Desktop: panel bergaris selebar 380px di kanan. Tombol peta dan keterangan bergeser ke kirinya.
  - HP: halaman penuh, dengan tombol tutup di kanan atas.
- **Kosong:** satu kalimat tentang apa yang bisa ditanya (hanya 6 simpang yang dipantau), lalu 4 pertanyaan contoh dalam kotak bergaris.
- **Percakapan:**
  - Pertanyaan pengguna ditulis di kotak hitam (hitam = kamu).
  - Jawaban ditulis di kertas putih dengan garis hitam di kiri.
  - Nama simpang di jawaban bisa diketuk (bergaris bawah, dengan tanda status langsungnya) dan membuka kartu simpang.
  - Jawaban soal rute punya tombol **Lihat rute … di peta**, yang membuka perencana rute (§4.5) dengan titik awal dan tujuan yang sama.
  - Selama menunggu: tiga kotak kecil berdenyut dan tulisan "Mengecek data…".
  - Di bawah jawaban terakhir: "Dijawab Groq (gratis) dari data StreetLens". Di kaki panel: "AI bisa keliru. Angka pasti ada di kartu simpang."
- **Jujur:**
  - Model **tidak pernah mengarang angka**. Ia hanya bisa menjawab lewat tiga alat di backend: status langsung, riwayat hari ini sejak 00:00 WITA, dan perencana rute.
  - Tempat di luar 6 simpang dijawab "belum ada kamera di sana".
  - Tidak ada perkiraan waktu tempuh atau ramalan.
  - Selama data masih sintetis, setiap jawaban menyebut "data sintetis".
- **Gagal:** pesan yang jelas untuk setiap keadaan: belum ada kunci, layanan penuh, kunci ditolak, atau tidak ada internet. Peta dan rute tetap jalan tanpa internet; hanya asisten yang butuh internet.

**Cara kerjanya (`backend/assistant.py`, `POST /api/chat`):**
- Hanya dua layanan, keduanya gratis, dan alamatnya dikunci di kode (ada tesnya): **Groq** (utama, sangat cepat) lalu **NVIDIA Build** (cadangan otomatis kalau Groq penuh atau mati).
- Kunci API ada di `.env` (lihat `.env.example`), tidak masuk git, dan tidak pernah sampai ke browser. **Jangan pernah menambahkan kartu kredit** ke akun Groq atau NVIDIA. Tanpa kartu, tidak ada yang bisa ditagih.
- Batas pemakaian di server: 10 pertanyaan per menit untuk semua orang, 5 per orang, dan pertanyaan maksimal 600 huruf. Ini supaya kuota gratis tidak habis.
- Data yang dikirim ke Groq/NVIDIA hanya pertanyaan dan angka lalu lintas. Tidak ada video atau data pribadi.

---

## 5. Semua keadaan sistem

**Keadaan kamera / data**, selalu tampil di samping label:

| Keadaan | Tulisan | Kapan |
|---|---|---|
| Langsung | Langsung · 3 dtk lalu | Data kurang dari 10 detik |
| Tertunda | Tertunda · 2 mnt | Data 10 detik sampai 5 menit |
| Rekaman | Rekaman · 13:52 WITA | Menampilkan rekaman, bukan langsung |
| Offline | Kamera offline sejak 13:40 WITA | Kamera mati. Riwayatnya tetap tampil. |
| Belum dianalisis | Belum dianalisis | Kamera ada di peta provinsi, tapi belum dikalibrasi |
| Sintetis (pengembangan) | Sintetis · 3 dtk lalu + bar hitam "DATA SINTETIS" | Data buatan, belum dari kamera asli |

**Keadaan aplikasi:**

| Keadaan | Perilaku |
|---|---|
| Pertama dibuka | Langsung ke koridor, tanpa minta izin apa pun |
| Memuat | Kerangka peta. Penanda muncul satu per satu. |
| Koneksi putus | "Koneksi terputus · data terakhir 14:05 WITA". Data lama tetap tampil. |
| HP lemah / WebGL tidak ada | "Mode ringan": peta 2D dan daftar |
| Tidak ada kamera di area | "Tidak ada kamera di area ini", dan tombol ke simpang terdekat |

---

## 6. Alat tim (`/tim`, tidak ditautkan ke publik)

Video mentah **hanya** muncul di sini, untuk keperluan tim.

- **Penghitung manual (sudah jadi).**
  - Video diputar 0,5×.
  - Tombol **M** motor, **C** mobil, **B** bus, **T** truk. Tahan Shift untuk arah keluar. **Z** membatalkan, tombol 1–9 memilih garis hitung.
  - Setiap orang menghitung sendiri, lalu hasilnya diekspor ke CSV untuk uji akurasi.
- **Pemutar analisis (sudah jadi):** video dengan kotak deteksi, garis hitung, dan area antrean.
- **Kembaran 3D di pemutar analisis (sudah jadi):**
  - `ground_px` dari `observations.json` diproyeksikan ke meter lewat homografi dari `calibration` di `config/<kamera>.yaml` (`lib/homography.ts`, `lib/worldTracks.ts`).
  - Sinkron dengan jam video. Galat hold-out dan sisa fit ditampilkan dalam meter.
  - Kendaraan yang hilang dari pelacak tampil abu-abu, lalu dihapus setelah 1 detik.
  - Tanpa kalibrasi, 3D tidak digambar dan muncul petunjuk cara mengisinya.
- **Kalibrasi (`/tim/kalibrasi`, sudah jadi):**
  - Buka tangkapan layar CCTV atau video (lalu pilih satu frame). Gambar hanya dibuka di browser, tidak diunggah.
  - Klik tanda di gambar, lalu tempel koordinatnya dari satelit Google Maps (klik kanan, salin "lat, lng"). Koordinat diubah ke meter dari titik asal (X timur, Y utara).
  - 8–10 titik fit dan 3 titik hold-out. Galat setiap titik tampil dalam meter, dengan target di bawah 1,5 m. Grid meter hasil fit diproyeksikan ke gambar, dan denah dari atas ikut digambar, supaya kesalahan terlihat.
  - Ada alat untuk menggambar poligon jalan, garis hitung (dengan arah datang dari lengan simpang), dan area antrean.
  - Hasilnya diunduh sebagai `config/<kamera>.yaml`. Draf tersimpan otomatis di browser, dan config yang sudah ada bisa dibuka lagi.

---

## 7. Ukuran layar

| Lebar | Tata letak |
|---|---|
| HP (< 600px), **utama** | Peta penuh, kotak cari di atas, panel bawah dengan 3 posisi (muncul setelah mencari atau mengetuk simpang) |
| Tablet (600–1023px) | Sama, panel maksimal 560px |
| Laptop / layar demo (≥ 1024px) | Peta dalam bingkai lembar peta. **Kartu kiri 400px** di bawah kotak cari, tombol di kanan atas, keterangan + skala di kanan bawah |

**Layar demo:** jenis layarnya belum pasti (proyektor atau laptop), jadi harus tetap terbaca dari jarak ±4 m dan pada zoom 125–150%.

## 8. Aksesibilitas (WCAG 2.2 AA)
- Peta tidak pernah jadi satu-satunya jalan. Daftar dan pencarian menjangkau semua simpang.
- Status ditunjukkan dengan kata + bentuk + warna.
- Urutan tombol Tab: cari → kartu → tombol peta → peta.
- Fokus keyboard terlihat jelas (garis hitam 3px).
- Pembaca layar mengumumkan perubahan status simpang yang sedang dipilih, dalam satu kalimat.
- Target sentuh 48px. Mendukung "kurangi gerakan". Atribut bahasa ikut berganti saat bahasa diganti.

## 9. Kinerja (HP Android kelas menengah, 4G)
- Peta siap dipakai dalam waktu kurang dari 3 detik. Total JavaScript sekitar 380 KB (gzip).
- Three.js (±136 KB gzip) baru dimuat **setelah** peta tampil, jadi tidak memperlambat layar pertama.
- Peta **seluruh Bali** disimpan sendiri (±112 MB, 12.455 potongan peta sampai zoom 15, `npm run tiles`), jadi demo tetap jalan **tanpa Wi-Fi**. Kalau ada potongan yang belum diunduh, backend mengambilnya sekali dari Protomaps saat online lalu menyimpannya (`backend/tilecache.py`).
- 3D:
  - Satu konteks WebGL (kendaraan digambar di dalam peta), berbagi depth buffer dengan gedung 3D: kendaraan tertutup gedung seperti aslinya.
  - Kendaraan hanya digambar mulai zoom 15. Di bawah itu, peta berhenti meminta frame baru (hemat baterai).
  - Maksimal 200 kendaraan per simpang, target 30 fps.
  - Pindah ke "Mode ringan" kalau di bawah 20 fps.

## 10. Gaya bahasa
- Bahasa Indonesia yang tenang dan apa adanya. Tidak lebay, tidak ada "AI memprediksi", tanpa tanda seru.
- Waktu ditulis relatif ("3 dtk lalu"), dan jam lengkap dalam **WITA** saat diketuk.
- Nama simpang tetap dalam bentuk lokal di kedua bahasa (tidak diterjemahkan jadi "Horse Statue Junction").
- **Istilah tetap:**

| Indonesia | Inggris |
|---|---|
| Lancar | Moving |
| Padat | Heavy |
| Macet | Jammed |
| Langsung | Live |
| Tertunda | Delayed |
| Rekaman | Replay |
| Rute | Route |
| Rute ke sini | Route here |
| Disarankan | Recommended |
| Pilih di peta | Choose on the map |
| Kenapa macet? | Why jammed? |
| Belum dianalisis | Not analysed yet |
| Tanpa data | No data |

---

## 11. Daftar fitur dan letaknya

| Fitur | Di mana | Status |
|---|---|---|
| Peta 3D Bali (seperti Google Maps) | Beranda | ✅ jadi |
| Penanda simpang (bentuk = status, ukuran = volume) | Peta | ✅ jadi |
| Ruas jalan dipantau diwarnai status | Peta | ✅ jadi |
| Tombol utara + papan arah U/T/S/B di jalan | Peta | ✅ jadi |
| Peta seluruh Bali, 3D sampai Bali utara | Peta | ✅ jadi |
| "Mau ke mana?": 1.670 tempat se-Bali | Kiri atas | ✅ jadi |
| Bingkai lembar peta: koordinat BT/LS + skala | Peta | ✅ jadi |
| Daftar simpang dari yang paling parah | Kartu area / kotak cari | ✅ jadi |
| Detail simpang: arah datang, strip 30 menit, jenis kendaraan | Simpang | ✅ jadi |
| Kenapa? (bukti angka) | Simpang → Kenapa | ✅ jadi |
| Cari (tahan salah ketik) + ID/EN | Atas | ✅ jadi |
| Kamera yang belum dianalisis (jujur) | Keterangan "Kamera provinsi" | ✅ jadi |
| Bagikan tautan (WhatsApp) | Simpang | ✅ jadi |
| Kesegaran data, offline, sintetis | Semua layar | ✅ jadi |
| Penghitung manual + pemutar analisis | /tim | ✅ jadi |
| Kembaran 3D: observations.json → homografi → posisi 3D, sinkron video | /tim/putar | ✅ jadi (diuji dengan klip + kalibrasi sintetis) |
| **Kendaraan 3D bergerak langsung** | Simpang | 🟡 Demo jadi (ilustrasi dari angka langsung). Posisi asli menunggu data kamera + kalibrasi |
| **Kamera asli langsung** (menggantikan data sintetis) | Backend | ⏳ Person A |
| Alat kalibrasi | /tim/kalibrasi | ✅ jadi (diuji dengan gambar uji ber-geometri pasti: galat hold-out 0,05 m). Kalibrasi 6 kamera asli menunggu tangkapan layar CCTV |
| Rute A → B, sampai 3 pilihan, sadar simpang macet + Google Maps | Tombol RUTE / Rute ke sini | ✅ jadi |
| Tanya lalu lintas: asisten AI gratis (Groq, cadangan NVIDIA) dari data sendiri | Tombol TANYA | ✅ jadi (aktif setelah kunci gratis diisi di `.env`) |
| Putar ulang 30 menit | Simpang | ⏳ Hari 4 |
| "Seberapa akurat?" dengan angka nyata | Simpang | ⏳ setelah uji akurasi (Hari 5) |
| Aksara Bali | Simpang | ⏳ kalau sempat (paling awal dipotong) |

## 12. Jadwal (bagian Person C)
| Hari | Aplikasi publik | Alat tim |
|---|---|---|
| 2 ✅ | Kerangka peta, gaya Nawa Sanga, cari, kompas, penanda, panel simpang, Kenapa? | Penghitung manual |
| 3 | Lapisan kendaraan 3D bersama B, uji di HP asli | Alat kalibrasi bersama B |
| 4 | Rute A → B (✅), putar ulang | — |
| 5 | Lengkapi semua keadaan, versi laptop, cek aksesibilitas | Perbandingan hasil hitung |
| 6 | Rapikan, perbaikan dari cek budaya, latihan demo di laptop RTX 5060 + proyektor | — |
| 7 | Kunci, tidak ada fitur baru | — |

**Urutan dipotong kalau telat:**
1. aksara Bali
2. putar ulang
3. kerapian versi laptop
4. jumlah simpang langsung (sisanya jujur sebagai "Rekaman")

**Tidak boleh dipotong:** kesegaran dan status yang jujur, minimal 1 simpang langsung dalam 3D, halaman Kenapa?, dan rute yang menghindari simpang demo saat macet.

## 13. Risiko dan hal yang belum diputuskan
| Hal | Catatan |
|---|---|
| **Izin** memakai dan menampilkan data CCTV | Belum ada. Portalnya bertuliskan "All Rights Reserved". Harus minta ke Diskominfos Bali sebelum demo. |
| **Cek budaya** aksara Bali | Hanya kalau aksara Bali dipakai. Nawa Sanga dan kaja/kelod sudah tidak dipakai (2026-11-03). |
| Kamera sering mati | Mode rekaman wajib ada sebagai cadangan |
| Kemampuan 1 GPU untuk 6 simpang langsung | Person A melakukan uji kecepatan |
| 3D lancar di HP | Uji di HP Android asli paling lambat Hari 5 |
| PLAN.md masih rencana lama (rekaman saja, untuk perencana) | Perlu disesuaikan untuk Person A (siaran langsung) dan B (kalibrasi 6 kamera) |
