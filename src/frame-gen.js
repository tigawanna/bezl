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

/**
 * Download a PNG from a URL and save it to dest.
 * Follows a single redirect if the server returns 301/302.
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
 * Generate (or retrieve from cache) a frame PNG with a transparent screen hole.
 *
 * Handles two frame source types:
 *   source: 'url' – download real device PNG from CDN, cache locally
 *   source: 'svg' – generate PNG from SVG using Sharp (original behaviour)
 *
 * @param {string} frameKey   – key from FRAMES registry
 * @param {object} frameDef   – the frame definition object
 * @param {string} scheme     – 'dark' | 'light'
 * @param {boolean} force     – ignore cache and regenerate / re-download
 * @returns {Promise<{ pngPath, frameSize, screen }>}
 */
async function getFramePng(frameKey, frameDef, scheme = "dark", force = false) {
  ensureCache();
  const dest = cachePath(frameKey, scheme);

  if (frameDef.source === "url") {
    const colorDef = frameDef.colors[scheme] ?? frameDef.colors.dark;

    if (!force && fs.existsSync(dest)) {
      return {
        pngPath: dest,
        frameSize: colorDef.frameSize,
        screen: colorDef.screen,
      };
    }

    await downloadPng(colorDef.url, dest);
    return {
      pngPath: dest,
      frameSize: colorDef.frameSize,
      screen: colorDef.screen,
    };
  }

  // SVG-generated frame (original path)
  if (!force && fs.existsSync(dest)) {
    const built = frameDef.build(scheme);
    return { pngPath: dest, frameSize: built.frameSize, screen: built.screen };
  }

  const { svg, frameSize, screen } = frameDef.build(scheme);

  await sharp(Buffer.from(svg)).png().toFile(dest);

  return { pngPath: dest, frameSize, screen };
}

module.exports = { getFramePng, CACHE_DIR };
