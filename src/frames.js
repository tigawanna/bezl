'use strict';

/**
 * Each frame defines:
 *   screen  – the transparent rectangle (x, y, width, height) where the video shows through
 *   size    – total dimensions of the frame PNG (width, height)
 *   ratios  – accepted video aspect ratios (w/h) for auto-detection
 *   svg()   – generates SVG string; 'dark' | 'light' color scheme
 *
 * SVG strategy:
 *   1. A <mask> punches a transparent hole at the screen coordinates.
 *   2. The phone body is drawn through that mask (body visible, screen transparent).
 *   3. Camera punch-hole and UI chrome are drawn on top (they overlay the video).
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bodyColors(scheme) {
  if (scheme === 'light') {
    return {
      bodyGrad0: '#e2e2e4',
      bodyGrad1: '#d0d0d2',
      bodyGrad2: '#b8b8ba',
      sheen: 'rgba(255,255,255,0.55)',
      button: '#c4c4c6',
      screenBorder: 'rgba(0,0,0,0.08)',
      homeBar: 'rgba(0,0,0,0.22)',
      camera0: '#c8c8ca',
      camera1: '#a0a0a2',
      camera2: '#888890',
    };
  }
  return {
    bodyGrad0: '#2c2c2e',
    bodyGrad1: '#1c1c1e',
    bodyGrad2: '#0f0f11',
    sheen: 'rgba(255,255,255,0.08)',
    button: '#2a2a2c',
    screenBorder: 'rgba(255,255,255,0.07)',
    homeBar: 'rgba(255,255,255,0.28)',
    camera0: '#1a1a1c',
    camera1: '#0a0a0c',
    camera2: '#050507',
  };
}

function defs(id, sx, sy, sw, sh, screenR, bodyR, fw, fh, c) {
  return `
  <defs>
    <mask id="${id}">
      <rect width="${fw}" height="${fh}" rx="${bodyR}" fill="white"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${screenR}" fill="black"/>
    </mask>
    <linearGradient id="g${id}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="${c.bodyGrad0}"/>
      <stop offset="45%"  stop-color="${c.bodyGrad1}"/>
      <stop offset="100%" stop-color="${c.bodyGrad2}"/>
    </linearGradient>
    <linearGradient id="s${id}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="${c.sheen}"/>
      <stop offset="50%"  stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>`;
}

// ─── Generic 9:16 ────────────────────────────────────────────────────────────
// Matches older 1080×1920 and similar 16:9 content. Slightly thicker bezels,
// no notch/punch-hole (older devices had a front camera in the bezel).

function genericSVG(sw, sh, scheme) {
  const SIDE = 52;
  const TOP  = 120;
  const BOT  = 180;
  const fw   = sw + SIDE * 2;
  const fh   = sh + TOP + BOT;
  const sx   = SIDE;
  const sy   = TOP;
  const bodyR   = 72;
  const screenR = 10;
  const c    = bodyColors(scheme);
  const cx   = fw / 2;

  // Front camera in top bezel
  const camY = sy / 2;

  return {
    frameSize: { width: fw, height: fh },
    screen: { x: sx, y: sy, width: sw, height: sh },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">
  ${defs('generic', sx, sy, sw, sh, screenR, bodyR, fw, fh, c)}

  <!-- Body with screen hole -->
  <rect width="${fw}" height="${fh}" fill="url(#ggeneric)" mask="url(#generic)"/>
  <rect width="${fw}" height="${fh}" fill="url(#sgeneric)" mask="url(#generic)"/>

  <!-- Screen edge highlight -->
  <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${screenR}"
        fill="none" stroke="${c.screenBorder}" stroke-width="1.5"/>

  <!-- Speaker grille (top bezel) -->
  <rect x="${cx - 80}" y="${sy / 2 - 5}" width="160" height="10" rx="5"
        fill="${c.camera1}" opacity="0.6"/>

  <!-- Front camera (top bezel, right of speaker) -->
  <circle cx="${cx + 120}" cy="${camY}" r="14" fill="${c.camera0}"/>
  <circle cx="${cx + 120}" cy="${camY}" r="9"  fill="${c.camera1}"/>
  <circle cx="${cx + 120}" cy="${camY}" r="4"  fill="${c.camera2}"/>

  <!-- Volume buttons (left) -->
  <rect x="-2" y="500" width="7" height="80" rx="3.5" fill="${c.button}"/>
  <rect x="-2" y="600" width="7" height="80" rx="3.5" fill="${c.button}"/>

  <!-- Power button (right) -->
  <rect x="${fw - 5}" y="560" width="7" height="110" rx="3.5" fill="${c.button}"/>

  <!-- Home bar area (thick bottom bezel, classic style) -->
  <circle cx="${cx}" cy="${fh - BOT / 2}" r="28" fill="none"
          stroke="${c.button}" stroke-width="4"/>
  <circle cx="${cx - 100}" cy="${fh - BOT / 2}" r="16" fill="none"
          stroke="${c.button}" stroke-width="4" opacity="0.5"/>
  <rect x="${cx + 72}" y="${fh - BOT / 2 - 12}" width="32" height="24" rx="4"
        fill="none" stroke="${c.button}" stroke-width="4" opacity="0.5"/>
</svg>`,
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────
//
// Two frame source types:
//   source: 'svg'  – generated locally via Sharp (existing behaviour)
//   source: 'url'  – real device PNG downloaded from open-source CDN and cached
//
// Real frames come from jonnyjackson26/device-frames-media (MIT-style open
// source).  Each color variant has { url, screen, frameSize }.

const GH = 'https://raw.githubusercontent.com/jonnyjackson26/device-frames-media/main/device-frames-output';

const FRAMES = {

  // ── Real device frames (photo-quality PNGs) ─────────────────────────────

  'pixel-9-pro': {
    name: 'Google Pixel 9 Pro',
    desc: '1080×2424 (20:9) — Real device frame, photo-quality',
    source: 'url',
    ratios: [1080 / 2424, 1080 / 2400],
    colors: {
      dark:  {
        url: `${GH}/Android%20Phone/Pixel%209%20Pro/Obsidian/frame.png`,
        screen:    { x: 170, y: 142, width: 1280, height: 2856 },
        frameSize: { width: 1620, height: 3136 },
      },
      light: {
        url: `${GH}/Android%20Phone/Pixel%209%20Pro/Rose%20Quartz/frame.png`,
        screen:    { x: 170, y: 142, width: 1280, height: 2856 },
        frameSize: { width: 1620, height: 3136 },
      },
    },
  },

  'pixel-9-pro-xl': {
    name: 'Google Pixel 9 Pro XL',
    desc: '1344×2992 (20:9) — Real device frame, photo-quality',
    source: 'url',
    ratios: [1344 / 2992],
    colors: {
      dark:  {
        url: `${GH}/Android%20Phone/Pixel%209%20Pro%20XL/Obsidian/frame.png`,
        screen:    { x: 170, y: 140, width: 1344, height: 2992 },
        frameSize: { width: 1684, height: 3272 },
      },
      light: {
        url: `${GH}/Android%20Phone/Pixel%209%20Pro%20XL/Rose%20Quartz/frame.png`,
        screen:    { x: 170, y: 140, width: 1344, height: 2992 },
        frameSize: { width: 1684, height: 3272 },
      },
    },
  },

  'pixel-8-pro': {
    name: 'Google Pixel 8 Pro',
    desc: '1344×2992 (20:9) — Real device frame, photo-quality',
    source: 'url',
    ratios: [1344 / 2992, 1080 / 2400],
    colors: {
      dark:  {
        url: `${GH}/Android%20Phone/Pixel%208%20Pro/Black/frame.png`,
        screen:    { x: 183, y: 169, width: 1255, height: 2792 },
        frameSize: { width: 1621, height: 3135 },
      },
      light: {
        url: `${GH}/Android%20Phone/Pixel%208%20Pro/Silver/frame.png`,
        screen:    { x: 183, y: 169, width: 1255, height: 2792 },
        frameSize: { width: 1621, height: 3135 },
      },
    },
  },

  'pixel-8': {
    name: 'Google Pixel 8',
    desc: '1080×2400 (20:9) — Real device frame, photo-quality',
    source: 'url',
    ratios: [1080 / 2400],
    colors: {
      dark:  {
        url: `${GH}/Android%20Phone/Pixel%208/Hazel/frame.png`,
        screen:    { x: 183, y: 169, width: 1145, height: 2549 },
        frameSize: { width: 1511, height: 2896 },
      },
      light: {
        url: `${GH}/Android%20Phone/Pixel%208/Hazel/frame.png`,
        screen:    { x: 183, y: 169, width: 1145, height: 2549 },
        frameSize: { width: 1511, height: 2896 },
      },
    },
  },

  'samsung-s21': {
    name: 'Samsung Galaxy S21',
    desc: '1080×2400 (20:9) — Real device frame, photo-quality',
    source: 'url',
    ratios: [1080 / 2400, 1080 / 2340],
    colors: {
      dark:  {
        url: `${GH}/Android%20Phone/Samsung%20Galaxy%20S21/Black/frame.png`,
        screen:    { x: 200, y: 200, width: 1080, height: 2400 },
        frameSize: { width: 1480, height: 2800 },
      },
      light: {
        url: `${GH}/Android%20Phone/Samsung%20Galaxy%20S21/White/frame.png`,
        screen:    { x: 200, y: 200, width: 1080, height: 2400 },
        frameSize: { width: 1480, height: 2800 },
      },
    },
  },

  // ── Generic SVG fallback (covers any 16:9 content not matching a real frame) ──

  'generic': {
    name: 'Generic Android',
    desc: '1080×1920 (16:9) — Classic 16:9 with top bezel camera',
    source: 'svg',
    defaultScreen: { width: 1080, height: 1920 },
    ratios: [9 / 16, 1080 / 1920],
    build: (scheme = 'dark') => genericSVG(1080, 1920, scheme),
  },
};

/**
 * Auto-detect the best frame for a given video width/height.
 * Prefers real PNG frames (source:'url') over SVG-generated ones when tied.
 */
function autoDetect(videoWidth, videoHeight) {
  const ratio = videoWidth / videoHeight;
  let bestKey  = 'pixel-9-pro';
  let bestDiff = Infinity;

  for (const [key, frame] of Object.entries(FRAMES)) {
    for (const r of frame.ratios) {
      const diff = Math.abs(ratio - r);
      const isReal = frame.source === 'url';
      // Prefer real frames by giving them a tiny tie-breaking advantage
      const adjusted = isReal ? diff - 0.0001 : diff;
      if (adjusted < bestDiff) {
        bestDiff = adjusted;
        bestKey  = key;
      }
    }
  }

  return bestKey;
}

module.exports = { FRAMES, autoDetect };
