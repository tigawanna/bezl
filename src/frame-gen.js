"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

let sharp;
try {
  sharp = require("sharp");
} catch {
  throw new Error(
    "sharp is not installed. Run: npm install\n" +
      "sharp is required to render device frame images.",
  );
}

/** Directory where generated / downloaded frame PNGs are cached between runs. */
const CACHE_DIR = path.join(os.homedir(), ".cache", "bezl");

function ensureCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cachePath(frameKey, scheme) {
  return path.join(CACHE_DIR, `${frameKey}-${scheme}.png`);
}

function maskCachePath(frameKey, scheme) {
  return path.join(CACHE_DIR, `${frameKey}-${scheme}-mask.png`);
}

/**
 * Download a PNG from a URL and save it to dest.
 * Follows redirects until a 200 response is received.
 */
function downloadPng(url, dest) {
  return new Promise((resolve, reject) => {
    const driver = url.startsWith("https") ? https : http;
    driver
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return downloadPng(res.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `Failed to download frame PNG (HTTP ${res.statusCode}): ${url}`,
            ),
          );
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            fs.writeFileSync(dest, Buffer.concat(chunks));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Build the screen clip mask from a frame PNG.
 *
 * The frame PNG has a transparent screen hole (alpha=0) and an opaque body
 * (alpha=255). We derive a full-frame grayscale mask where the hole=255 and
 * the body=0 by extracting and negating the alpha channel.
 *
 * This mask is used by FFmpeg (alphamerge) and Sharp (joinChannel) to clip
 * video/screenshot content to the exact screen-hole shape — including the
 * frame's native corner rounding — before compositing.
 */
async function buildScreenMask(framePngPath, maskPath) {
  await sharp(framePngPath)
    .extractChannel("alpha") // body=255, hole=0
    .negate()                 // body=0,   hole=255 (show content here)
    .toFile(maskPath);
}

/**
 * Generate (or retrieve from cache) a frame PNG with a transparent screen hole,
 * and its corresponding screen clip mask.
 *
 * Handles two frame source types:
 *   source: 'url' – download real device PNG from CDN, cache locally
 *   source: 'svg' – generate PNG from SVG using Sharp
 *
 * @param {string}  frameKey  – key from FRAMES registry
 * @param {object}  frameDef  – the frame definition object
 * @param {string}  scheme    – 'dark' | 'light'
 * @param {boolean} force     – ignore cache and regenerate / re-download
 * @returns {Promise<{ pngPath, frameSize, screen, screenMaskPath }>}
 */
async function getFramePng(frameKey, frameDef, scheme = "dark", force = false) {
  ensureCache();
  const dest     = cachePath(frameKey, scheme);
  const maskDest = maskCachePath(frameKey, scheme);

  if (frameDef.source === "url") {
    const colorDef = frameDef.colors[scheme] ?? frameDef.colors.dark;

    if (!force && fs.existsSync(dest)) {
      if (!fs.existsSync(maskDest)) await buildScreenMask(dest, maskDest);
      return { pngPath: dest, frameSize: colorDef.frameSize, screen: colorDef.screen, screenMaskPath: maskDest };
    }

    await downloadPng(colorDef.url, dest);
    await buildScreenMask(dest, maskDest);
    return { pngPath: dest, frameSize: colorDef.frameSize, screen: colorDef.screen, screenMaskPath: maskDest };
  }

  // SVG-generated frame
  if (!force && fs.existsSync(dest)) {
    if (!fs.existsSync(maskDest)) await buildScreenMask(dest, maskDest);
    const built = frameDef.build(scheme);
    return { pngPath: dest, frameSize: built.frameSize, screen: built.screen, screenMaskPath: maskDest };
  }

  const { svg, frameSize, screen } = frameDef.build(scheme);
  await sharp(Buffer.from(svg)).png().toFile(dest);
  await buildScreenMask(dest, maskDest);

  return { pngPath: dest, frameSize, screen, screenMaskPath: maskDest };
}

module.exports = { getFramePng, CACHE_DIR };
