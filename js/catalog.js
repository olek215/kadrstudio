// Katalogi: filtry, przejścia, animacje, czcionki, style napisów, naklejki.

export const FILTERS = {
  none: { name: 'Brak', css: '' },
  vivid: { name: 'Żywy', css: 'saturate(1.45) contrast(1.08)' },
  warm: { name: 'Ciepły', css: 'saturate(1.15) brightness(1.03)', tint: ['#ff8a00', 0.12] },
  cold: { name: 'Zimny', css: 'saturate(0.95) hue-rotate(-6deg)', tint: ['#1d7bff', 0.13] },
  cinema: { name: 'Kino', css: 'contrast(1.18) saturate(0.85)', tint: ['#008c9e', 0.09], vignette: 0.35 },
  drama: { name: 'Dramat', css: 'contrast(1.35) brightness(0.92) saturate(0.7)', vignette: 0.45 },
  vintage: { name: 'Vintage', css: 'sepia(0.45) contrast(0.92) brightness(1.05) saturate(0.85)', tint: ['#ff9a3c', 0.08], vignette: 0.25 },
  sunset: { name: 'Zachód', css: 'saturate(1.3) contrast(1.05)', tint: ['#ff3d6e', 0.14] },
  dream: { name: 'Sen', css: 'brightness(1.1) saturate(1.25) contrast(0.9)', tint: ['#ff66cc', 0.08] },
  fade: { name: 'Wyblakły', css: 'contrast(0.82) brightness(1.1) saturate(0.7)' },
  bw: { name: 'Cz-B', css: 'grayscale(1) contrast(1.15)' },
  noir: { name: 'Noir', css: 'grayscale(1) contrast(1.6) brightness(0.9)', vignette: 0.5 },
  neon: { name: 'Neon', css: 'saturate(2.1) contrast(1.12) hue-rotate(12deg)' },
  matrix: { name: 'Matrix', css: 'grayscale(0.6) contrast(1.2)', tint: ['#00ff66', 0.18] },
  sepia: { name: 'Sepia', css: 'sepia(0.9) contrast(1.05)' },
  invert: { name: 'Negatyw', css: 'invert(1)' },
};

export const TRANSITIONS = [
  { id: 'none', name: 'Brak' },
  { id: 'fade', name: 'Przenikanie' },
  { id: 'black', name: 'Przez czerń' },
  { id: 'white', name: 'Błysk' },
  { id: 'slideleft', name: 'Wjazd ←' },
  { id: 'slideright', name: 'Wjazd →' },
  { id: 'slideup', name: 'Wjazd ↑' },
  { id: 'slidedown', name: 'Wjazd ↓' },
  { id: 'zoomin', name: 'Przybliżenie' },
  { id: 'zoomout', name: 'Oddalenie' },
  { id: 'wipeleft', name: 'Kurtyna' },
  { id: 'wipeup', name: 'Roleta' },
  { id: 'circle', name: 'Koło' },
  { id: 'blur', name: 'Rozmycie' },
  { id: 'spin', name: 'Wir' },
  { id: 'glitch', name: 'Glitch' },
];

export const MOTIONS = [
  { id: 'none', name: 'Brak' },
  { id: 'zoomin', name: 'Najazd' },
  { id: 'zoomout', name: 'Odjazd' },
  { id: 'panleft', name: 'Panorama ←' },
  { id: 'panright', name: 'Panorama →' },
  { id: 'panup', name: 'Panorama ↑' },
  { id: 'pandown', name: 'Panorama ↓' },
  { id: 'pulse', name: 'Puls' },
  { id: 'shake', name: 'Trzęsienie' },
];

// Efekty kamery w wybranej chwili (osobne klipy na ścieżce „Efekty”, działają na główny obraz).
export const FX_TYPES = {
  zoom: { name: 'Zoom', icon: 'zoom-in', dur: 0.5 },
  zoomhold: { name: 'Przybliżenie', icon: 'scan-search', dur: 1.6 },
  tilt: { name: 'Przechył', icon: 'rotate-cw', dur: 0.7 },
  spin: { name: 'Obrót 360°', icon: 'refresh-cw', dur: 0.8 },
  shake: { name: 'Trzęsienie', icon: 'vibrate', dur: 0.6 },
  pulse: { name: 'Puls', icon: 'heart-pulse', dur: 0.5 },
  flash: { name: 'Błysk', icon: 'sun', dur: 0.35 },
};

export const ANIM_IN = [
  { id: 'none', name: 'Brak' }, { id: 'fade', name: 'Pojawienie' }, { id: 'pop', name: 'Wyskok' },
  { id: 'zoom', name: 'Z bliska' }, { id: 'slideup', name: 'Z dołu' }, { id: 'slidedown', name: 'Z góry' },
  { id: 'slideleft', name: 'Z prawej' }, { id: 'slideright', name: 'Z lewej' }, { id: 'bounce', name: 'Odbicie' },
  { id: 'blur', name: 'Ostrość' }, { id: 'spin', name: 'Obrót' }, { id: 'flicker', name: 'Migotanie' },
  { id: 'typewriter', name: 'Maszyna do pisania' }, { id: 'words', name: 'Słowo po słowie' }, { id: 'karaoke', name: 'Karaoke' },
];
export const ANIM_OUT = [
  { id: 'none', name: 'Brak' }, { id: 'fade', name: 'Zniknięcie' }, { id: 'pop', name: 'Zapadnięcie' },
  { id: 'zoom', name: 'Odlot' }, { id: 'slideup', name: 'W górę' }, { id: 'slidedown', name: 'W dół' },
  { id: 'blur', name: 'Rozmycie' },
];
export const LOOPS = [
  { id: 'none', name: 'Brak' }, { id: 'pulse', name: 'Puls' }, { id: 'wiggle', name: 'Kiwanie' },
  { id: 'float', name: 'Unoszenie' }, { id: 'shake', name: 'Drżenie' }, { id: 'spin', name: 'Kręcenie' },
];

export const BLENDS = [
  { id: 'source-over', name: 'Normalny' }, { id: 'screen', name: 'Rozjaśnij (screen)' }, { id: 'multiply', name: 'Mnożenie' },
  { id: 'overlay', name: 'Nakładka' }, { id: 'lighten', name: 'Jaśniejszy' }, { id: 'darken', name: 'Ciemniejszy' },
  { id: 'difference', name: 'Różnica' }, { id: 'color-dodge', name: 'Rozświetlenie' },
];

export const FONTS = [
  'Montserrat', 'Poppins', 'Inter', 'Bebas Neue', 'Anton', 'Oswald', 'Bangers', 'Righteous', 'Rubik Mono One',
  'Pacifico', 'Lobster', 'Permanent Marker', 'Caveat', 'Playfair Display', 'Press Start 2P',
  'Arial', 'Impact', 'Georgia', 'Segoe UI', 'Comic Sans MS', 'Courier New',
];

// Gotowe style napisów. "css" = jak wygląda karta w bibliotece.
export const TEXT_PRESETS = [
  { label: 'Tytuł', p: { text: 'TYTUŁ', font: 'Montserrat', weight: 900, size: 130, shadow: 22, shadowColor: '#000000', animIn: 'pop' },
    css: 'font:900 26px Montserrat;color:#fff;text-shadow:0 3px 10px #000' },
  { label: 'Napis z tłem', p: { text: 'Napis z tłem', font: 'Poppins', weight: 700, size: 66, color: '#111111', boxColor: '#ffffff', boxAlpha: 1, boxRadius: 16, animIn: 'pop' },
    css: 'font:700 15px Poppins;color:#111;background:#fff;padding:3px 8px;border-radius:5px' },
  { label: 'Czerwony pasek', p: { text: 'TO JEST HIT!', font: 'Montserrat', weight: 900, size: 74, color: '#ffffff', boxColor: '#ff2d55', boxAlpha: 1, boxRadius: 10, animIn: 'slideleft' },
    css: 'font:900 14px Montserrat;color:#fff;background:#ff2d55;padding:3px 8px;border-radius:4px' },
  { label: 'Komiks', p: { text: 'BUM!', font: 'Bangers', weight: 400, size: 170, color: '#ffe600', stroke: '#000000', strokeW: 9, rotation: -5, animIn: 'bounce', loop: 'pulse', spacing: 4 },
    css: 'font:400 30px Bangers;color:#ffe600;-webkit-text-stroke:1.5px #000;transform:rotate(-5deg);letter-spacing:1px' },
  { label: 'Neon', p: { text: 'Neon', font: 'Righteous', weight: 400, size: 130, color: '#ffffff', shadow: 38, shadowColor: '#ff2bd6', animIn: 'flicker' },
    css: 'font:400 28px Righteous;color:#fff;text-shadow:0 0 6px #ff2bd6,0 0 14px #ff2bd6' },
  { label: 'Kinowy', p: { text: 'KINOWY TYTUŁ', font: 'Bebas Neue', weight: 400, size: 150, spacing: 14, animIn: 'blur', animDur: 0.9 },
    css: 'font:400 26px "Bebas Neue";color:#fff;letter-spacing:3px' },
  { label: 'Elegancki', p: { text: 'Elegancko', font: 'Playfair Display', weight: 700, italic: true, size: 112, color: '#f6e7c8', animIn: 'slideup', animDur: 0.7 },
    css: 'font:italic 700 22px "Playfair Display";color:#f6e7c8' },
  { label: 'Odręczny', p: { text: 'Hej! :)', font: 'Permanent Marker', weight: 400, size: 120, color: '#ffffff', rotation: -3, animIn: 'pop' },
    css: 'font:400 22px "Permanent Marker";color:#fff;transform:rotate(-3deg)' },
  { label: 'Krzyk', p: { text: 'UWAGA', font: 'Anton', weight: 400, size: 200, upper: true, color: '#ffffff', stroke: '#000000', strokeW: 8, animIn: 'zoom', loop: 'shake' },
    css: 'font:400 30px Anton;color:#fff;-webkit-text-stroke:1px #000' },
  { label: 'Karaoke', p: { text: 'tak wyglądają napisy karaoke', font: 'Montserrat', weight: 900, size: 76, color: '#ffffff', stroke: '#000000', strokeW: 8, hl: '#ffd400', animIn: 'karaoke', animOut: 'none', y: 0.22, duration: 4 },
    css: 'font:900 13px Montserrat;color:#fff;-webkit-text-stroke:.6px #000'
    , html: '<span style="color:#ffd400">tak</span> wyglądają napisy' },
  { label: 'Słowo po słowie', p: { text: 'słowo po słowie robi wrażenie', font: 'Montserrat', weight: 900, size: 84, upper: true, color: '#ffffff', stroke: '#000000', strokeW: 6, animIn: 'words', animOut: 'fade', y: 0.18, duration: 3.5 },
    css: 'font:900 13px Montserrat;color:#fff;text-transform:uppercase' },
  { label: 'Maszyna', p: { text: 'pisze się samo...', font: 'Courier New', weight: 700, size: 70, color: '#33ff77', boxColor: '#000000', boxAlpha: 0.75, boxRadius: 6, animIn: 'typewriter', animOut: 'fade', animDur: 1.6 },
    css: 'font:700 14px "Courier New";color:#33ff77;background:#000c;padding:3px 6px' },
  { label: 'Retro gra', p: { text: 'LEVEL UP!', font: 'Press Start 2P', weight: 400, size: 64, color: '#ffffff', stroke: '#7c3aed', strokeW: 6, animIn: 'bounce', loop: 'float' },
    css: 'font:400 11px "Press Start 2P";color:#fff;-webkit-text-stroke:.5px #7c3aed' },
  { label: 'Gradient pill', p: { text: 'NOWOŚĆ', font: 'Rubik Mono One', weight: 400, size: 70, color: '#ffffff', boxColor: '#8b5cf6', boxAlpha: 1, boxRadius: 60, boxPad: 0.45, animIn: 'pop', loop: 'wiggle' },
    css: 'font:400 13px "Rubik Mono One";color:#fff;background:linear-gradient(90deg,#8b5cf6,#ec4899);padding:4px 10px;border-radius:30px' },
  { label: 'Podpis', p: { text: 'Imię Nazwisko\nkim jest', font: 'Inter', weight: 700, size: 58, color: '#ffffff', boxColor: '#000000', boxAlpha: 0.55, boxRadius: 12, align: 'left', x: -0.2, y: 0.3, animIn: 'slideright' },
    css: 'font:700 13px Inter;color:#fff;background:#0008;padding:3px 8px;border-radius:4px;text-align:left' },
  { label: 'Odręczny 2', p: { text: 'super dzień', font: 'Caveat', weight: 700, size: 140, color: '#ffd1e8', animIn: 'fade', loop: 'float' },
    css: 'font:700 26px Caveat;color:#ffd1e8' },
];

export const STICKERS = {
  'Popularne': ['🔥', '😂', '❤️', '👍', '✨', '🎉', '💯', '😎', '🤯', '👀', '⭐', '🚀', '💥', '⚡', '🙌', '🥳', '😱', '🤔', '💪', '🏆'],
  'Emocje': ['😀', '😍', '🥰', '😭', '😡', '🤩', '😴', '🤪', '😇', '🥺', '😏', '🙄', '🤫', '😬', '🤣', '😤', '🫠', '🤗', '😵‍💫', '🫡'],
  'Strzałki i znaki': ['⬆️', '➡️', '⬇️', '⬅️', '↗️', '🔴', '✅', '❌', '⚠️', '❓', '❗', '💬', '💭', '📍', '🔔', '🆕', '🔝', '🎯', '💡', '🔊'],
  'Rzeczy': ['🎬', '📸', '🎮', '🎧', '🎵', '🎤', '📱', '💻', '⚽', '🏀', '🍕', '🍔', '🍩', '🎂', '🎁', '💰', '👑', '🌈', '☀️', '🌙'],
};
