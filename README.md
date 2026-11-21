# KadrStudio – edytor rolek i filmów

Program do montażu rolek (TikTok / Reels / Shorts) i zwykłych filmów. Działa w oknie Microsoft Edge
jak normalna aplikacja; wszystko zostaje na tym komputerze.

## Uruchamianie

- Skrót **KadrStudio** na pulpicie (albo `KadrStudio.cmd` w tym folderze).
- Otwiera się małe zminimalizowane okno serwera – jego zamknięcie wyłącza program.
- Gotowe filmy trafiają do folderu **`Filmy`** obok tego pliku.

## Auto-montaż – film składa się sam

Na ekranie startowym kliknij **„Zrób film automatycznie”** (albo w edytorze **Auto-montaż**), wybierz filmy i zdjęcia.
Program sam:
- słucha muzyki i znajduje jej rytm (BPM) – cięcia wypadają na uderzenia,
- w każdym filmie szuka najciekawszych ujęć (ostre, z ruchem, nie za ciemne),
- dobiera przejścia, ruch kamery, filtr i tytuł według stylu: Energiczny, Spokojny, Vlog, Kinowy,
- dokłada muzykę (Twoją albo wbudowany bit) i wycisza ją na końcu.
Nie podoba się? **Inna wersja** losuje nowy montaż. Wszystko można potem poprawić ręcznie.

## Usuwanie powtórek

Nagrałeś zdanie kilka razy, bo się pomyliłeś? Kliknij **Powtórki** na pasku osi czasu (albo prawy klik na klipie).
Program rozpoznaje mowę na tym komputerze (Whisper, bez internetu), znajduje zdania powtórzone pod rząd
(też ucięte w połowie i wtrącenia typu „yyy, jeszcze raz”, „nie, czekaj”), zaznacza najlepszą wersję
(pełne zdanie, wyraźnie, bez „yyy”) i po zatwierdzeniu wycina resztę. Możesz wybrać inną wersję i odsłuchać każdą.
Pierwsze uruchomienie pobiera model mowy (ok. 480 MB do `mowa/models`). Przykład do wypróbowania: `samples/powtorki.mp4`.

## Napisy z mowy

Kliknij **Napisy** na pasku osi czasu (albo w zakładce Tekst „Napisy z mowy”). Program sam rozpozna słowa
i wstawi napisy zsynchronizowane z głosem. Style: **Karaoke** (słowo podświetla się, gdy je mówisz),
**Słowo po słowie**, **Duże słowa** (1–2 słowa naraz, styl TikToka), **Z tłem**, **Klasyczne**; do tego ile słów
naraz, położenie i WIELKIE LITERY. Każdy napis to zwykły tekst – kliknij i popraw.
Po zaznaczeniu filmu zakładka **Słowa** pokazuje, co w nim mówisz; kliknięcie słowa przenosi w to miejsce.

## Efekty z mowy

Przycisk **Efekty** na pasku osi czasu. Gdy w filmie padnie słowo-klucz, program sam dodaje dźwięk, ruch obrazu
i naklejkę, np. „zaobserwujcie” → dzwoneczek + obrót obrazu + 🔔, „polub/łapka” → pyk + zoom + ❤️, „wow”, „uwaga”,
„sekret”, „komentarz”, „pieniądze”, „do zobaczenia”… Każdą regułę można wyłączyć albo zmienić dźwięk i ruch.
Efekty obrazu (Zoom, Przybliżenie, Przechył, Obrót 360°, Trzęsienie, Puls, Błysk) leżą na ścieżce „Efekty” –
można je przesuwać, usuwać i dodawać ręcznie (zakładka Przejścia).
Mowę rozpoznaje komputer (szybko) albo – na telefonie – sama aplikacja (model ok. 124 MB pobiera się raz).

## Gdzie są pliki

Pliki projektów (filmy, zdjęcia, muzyka) zapisują się w folderze **`Projekty`** obok programu (dysk D:),
a gotowe filmy w **`Filmy`**. W pamięci przeglądarki zostają tylko małe opisy projektów.

## Na telefonie – jako aplikacja

Otwórz adres z „KadrStudio na telefon” (kod QR), potem w Chrome przycisk **Zainstaluj** na ekranie startowym
(albo ⋮ → „Zainstaluj aplikację”). KadrStudio pojawi się jako aplikacja z ikoną, bez paska przeglądarki.
Po pierwszym otwarciu działa także przy wyłączonym laptopie (montaż i eksport dzieją się w telefonie).

## Co potrafi

- **Formaty:** 9:16 (rolka), 16:9, 1:1, 4:5, 21:9; 24–60 kl/s.
- **Oś czasu:** wiele ścieżek (główna, nakładki, napisy, audio), przeciąganie, przycinanie krawędzi,
  dzielenie (S), magnes (klipy sklejają się bez dziur), przyciąganie, zoom, cofnij/ponów, kopiuj/wklej.
- **Obraz:** wypełnij / zmieść z rozmytym tłem, pozycja, skala, obrót, krycie, odbicia, zaokrąglenie,
  ramka, cień, tryby mieszania, przesuwanie i skalowanie myszą lub dwoma palcami na podglądzie.
- **Animacja:** klatki kluczowe (◆) dla pozycji, skali, obrotu i krycia; ruch kamery (Ken Burns, panorama,
  puls, trzęsienie); pojawianie i znikanie.
- **Przejścia (16):** przenikanie, przez czerń, błysk, wjazdy, przybliżenie, kurtyna, koło, rozmycie, wir, glitch…
- **Filtry (16) i korekcja:** jasność, kontrast, nasycenie, odcień, temperatura, winieta, rozmycie.
- **Zielony ekran** (chroma key) z usuwaniem zielonej poświaty.
- **Napisy:** 16 gotowych stylów, 21 czcionek, obrys, tło, cień/neon, animacje wejścia/wyjścia,
  maszyna do pisania, słowo po słowie, karaoke, ciągły ruch; naklejki (emoji).
- **Dźwięk:** muzyka z pliku, fala dźwięku na osi, głośność do 200%, narastanie/wyciszanie, odłączanie
  dźwięku od filmu, nagrywanie lektora z mikrofonu, wbudowane bity i efekty dźwiękowe (bez praw autorskich).
- **Prędkość** 0.1×–8× (slow-motion, timelapse), stop-klatka, zapis klatki do PNG.
- **Eksport MP4** (H.264 + AAC) 720p–4K, szybciej niż w czasie rzeczywistym (WebCodecs).
- Pliki, których przeglądarka nie otworzy (np. AVI, WMV), są automatycznie konwertowane przez ffmpeg.
- Projekty zapisują się same; lista projektów na ekranie startowym.

## Skróty

Spacja – odtwórz/pauza • S – podziel • Delete – usuń • Ctrl+Z / Ctrl+Y – cofnij/ponów •
Ctrl+D – duplikuj • ←/→ – klatka (Shift: sekunda) • ↑/↓ – poprzednie/następne cięcie • T – tekst • Ctrl+E – eksport

## Technicznie

Czysty HTML/JS (bez budowania). `server.py` (Python 3) serwuje aplikację na `http://localhost:5180`,
zapisuje eksporty i konwertuje pliki przez ffmpeg. Biblioteki w `vendor/`: lucide (ikony),
mp4-muxer (zapis MP4), mp4box.js (szybkie dekodowanie przy eksporcie).
