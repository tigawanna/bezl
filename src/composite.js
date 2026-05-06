'use strict';

const { spawn } = require('child_process');
const { chooseEncoder } = require('./encoder');

let sharp;
try {
  sharp = require('sharp');
} catch {
  // sharp is only required for compositeImage — video compositing (composite) does not need it.
}

/**
 * Composite a screen recording with a device frame PNG using FFmpeg.
 *
 * Pipeline:
 *   1. Scale the input video to fit the frame's screen area (letterbox if needed).
 *   2. Pad to the full frame canvas with black. Convert to RGBA.
 *   3. alphamerge with the screen clip mask to clip content to the exact
 *      screen-hole shape (including the frame's native corner rounding).
 *   4. Overlay the frame PNG on top.
 *   5. Optionally scale the whole output by --scale factor.
 *
 * @param {object} opts
 * @param {string}  opts.input           – path to screen recording
 * @param {string}  opts.framePng        – path to generated frame PNG
 * @param {string}  opts.screenMaskPath  – path to screen clip mask PNG (fw×fh grayscale)
 * @param {object}  opts.screen          – { x, y, width, height } of screen in frame
 * @param {object}  opts.frameSize       – { width, height } of full frame PNG
 * @param {string}  opts.output          – output file path
 * @param {number}  opts.fps             – source video frame rate
 * @param {boolean} opts.hasAudio        – whether to copy audio
 * @param {number}  [opts.scale=1]       – output scale multiplier (0.5 = half size)
 * @param {number}  [opts.speed=1]       – playback speed multiplier (e.g. 1.2 = 20% faster)
 * @param {number}  [opts.crf=18]        – H.264 CRF quality (0=lossless, 51=worst)
 * @param {string}  [opts.preset='fast'] – FFmpeg encoding preset
 * @param {function} [opts.onProgress]   – called with { elapsed } as encoding progresses
 */
async function composite(opts) {
  const {
    input,
    framePng,
    screenMaskPath,
    screen,
    frameSize,
    output,
    fps,
    hasAudio,
    scale    = 1,
    speed    = 1,
    crf      = 18,
    preset   = 'fast',
    onProgress,
  } = opts;

  const { x: sx, y: sy, width: sw, height: sh } = screen;
  const { width: fw, height: fh } = frameSize;

  /*
   * Filter graph:
   *
   * [0:v] → scale to fit within the screen area (letterbox, AR preserved)
   *       → single pad to the full frame canvas at screen position
   *       → format=rgba (required for alphamerge)
   *       → [padded]
   *
   * [padded][2:v] alphamerge → clip video to the exact screen-hole shape
   *       (mask: hole=255, body=0 — derived from the frame PNG's alpha channel)
   *       → [base]
   *
   * [base][1:v] overlay=0:0 → frame chrome sits on top, body covers outside
   *       → [framed]
   *
   * [framed] → optional rescale + speed + yuv420p → [out]
   *
   * Single pad only: avoids the double-pad frame-drop bug on pipe inputs.
   */
  const scaleAndPad = [
    `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=decrease`,
    `pad=${fw}:${fh}:${sx}+(${sw}-iw)/2:${sy}+(${sh}-ih)/2:black`,
    `format=rgba[padded]`,
  ].join(',');

  const applyMask   = `[padded][2:v]alphamerge[base]`;
  const overlayFrame = `[base][1:v]overlay=0:0:eof_action=repeat[framed]`;

  const speedSuffix = speed !== 1 ? `,setpts=PTS/${speed}` : '';
  let finalStep;
  if (scale !== 1) {
    const outW = Math.round(fw * scale / 2) * 2;
    const outH = Math.round(fh * scale / 2) * 2;
    finalStep = `;[framed]scale=${outW}:${outH}:flags=lanczos${speedSuffix},format=yuv420p[out]`;
  } else if (speed !== 1) {
    finalStep = `;[framed]setpts=PTS/${speed},format=yuv420p[out]`;
  } else {
    finalStep = `;[framed]format=yuv420p[out]`;
  }

  const filterComplex = `${scaleAndPad};${applyMask};${overlayFrame}${finalStep}`;

  const args = [
    '-i', input,
    '-i', framePng,
    '-i', screenMaskPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
  ];

  if (hasAudio) {
    args.push('-map', '0:a?');
    if (speed !== 1) {
      args.push('-filter:a', `atempo=${speed}`, '-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-c:a', 'copy');
    }
  }

  const encoder = chooseEncoder(preset, crf);
  args.push(
    ...encoder.args,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    output,
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);

    let stderrBuf = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;

      if (onProgress) {
        const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
        if (timeMatch) {
          const elapsed =
            parseInt(timeMatch[1]) * 3600 +
            parseInt(timeMatch[2]) * 60 +
            parseFloat(timeMatch[3]);
          onProgress({ elapsed });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrBuf.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}:\n${tail}`));
      }
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html'
        ));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Composite a static screenshot with a device frame using Sharp.
 *
 * Pipeline (all Sharp, no FFmpeg):
 *   1. Scale + pad the screenshot to exactly sw×sh (black bars if AR differs).
 *   2. Derive a clip mask from the frame PNG's alpha channel: the transparent
 *      screen hole becomes 255 (show content) and the opaque body becomes 0
 *      (hide content). This exactly matches the frame's corner rounding.
 *   3. Apply the clip mask as the screenshot's alpha channel.
 *   4. Place the clipped screenshot at (sx, sy) on a black fw×fh canvas.
 *   5. Overlay the frame PNG on top.
 *   6. Optionally rescale the whole output by --scale factor.
 *
 * @param {object} opts
 * @param {string}  opts.input      – path to PNG / JPG / WebP screenshot
 * @param {string}  opts.framePng   – path to generated frame PNG
 * @param {object}  opts.screen     – { x, y, width, height } of screen in frame
 * @param {object}  opts.frameSize  – { width, height } of full frame PNG
 * @param {string}  opts.output     – output file path (should be .png)
 * @param {number}  [opts.scale=1]  – output scale multiplier (0.5 = half size)
 */
async function compositeImage(opts) {
  if (!sharp) {
    throw new Error(
      'sharp is not installed. Run: npm install\n' +
      'sharp is required for image compositing.',
    );
  }

  const { input, framePng, screen, frameSize, output, scale = 1 } = opts;
  const { x: sx, y: sy, width: sw, height: sh } = screen;
  const { width: fw, height: fh } = frameSize;

  // Scale the screenshot to fill the screen area completely (fit: 'cover').
  // cover scales to the larger dimension and centre-crops the smaller, avoiding
  // the black letterbox bars that fit: 'contain' / 'inside' would add at the
  // edges of the screen hole. For phone screenshots the crop is negligible
  // (typically 0-5px per side). removeAlpha() guarantees RGB (3 channels) so
  // joinChannel below correctly adds the mask as the 4th alpha channel.
  const paddedBuf = await sharp(input)
    .resize(sw, sh, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .toBuffer();

  // Derive clip mask from the frame PNG's own alpha channel.
  // frame alpha: body=255 (opaque), hole=0 (transparent)
  // after negate: body=0 (hide), hole=255 (show) — exact corner rounding included.
  // Use .raw() to get a single-channel byte buffer; toBuffer() alone would encode
  // as a 3-channel PNG which joinChannel would add as 3 channels instead of 1.
  const { data: maskData } = await sharp(framePng)
    .extract({ left: sx, top: sy, width: sw, height: sh })
    .extractChannel('alpha')
    .negate()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // The frame PNG has two kinds of alpha=0 pixels: the screen hole (inside the
  // phone body) and the transparent background (outside the phone body at the
  // outer corners). The negate-based mask above treats both as "show content",
  // which causes the screenshot corners to bleed outside the phone frame.
  //
  // Fix: scan the full frame row-by-row to find the phone body's leftmost and
  // rightmost opaque pixel. Zero out any mask column that falls to the left of
  // that left edge or to the right of that right edge — those are background
  // pixels, not screen-hole pixels.
  const { data: frameRaw, info: frameInfo } =
    await sharp(framePng).raw().toBuffer({ resolveWithObject: true });
  const { width: framePngW, channels: framePngC } = frameInfo;

  for (let row = 0; row < sh; row++) {
    const frameRow = sy + row;
    // Find phone body bounds in the full frame row (first / last opaque pixel).
    let bodyLeft = framePngW;
    for (let x = 0; x < framePngW; x++) {
      if (frameRaw[(frameRow * framePngW + x) * framePngC + 3] >= 128) { bodyLeft = x; break; }
    }
    let bodyRight = -1;
    for (let x = framePngW - 1; x >= 0; x--) {
      if (frameRaw[(frameRow * framePngW + x) * framePngC + 3] >= 128) { bodyRight = x; break; }
    }
    if (bodyLeft > bodyRight) continue; // transparent row — nothing to zero
    // Zero mask columns that are outside the phone body in this row.
    for (let col = 0; col < sw; col++) {
      const frameX = sx + col;
      if (frameX < bodyLeft || frameX > bodyRight) {
        maskData[row * sw + col] = 0;
      }
    }
  }

  // Apply the mask as the screenshot's alpha channel (raw single-channel data).
  const clippedBuf = await sharp(paddedBuf)
    .joinChannel(maskData, { raw: { width: sw, height: sh, channels: 1 } })
    .toBuffer();

  // Composite clipped screenshot onto black canvas, then overlay frame.
  let pipeline = sharp({
    create: { width: fw, height: fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).composite([
    { input: clippedBuf, left: sx, top: sy },
    { input: framePng },
  ]);

  if (scale !== 1) {
    const outW = Math.round((fw * scale) / 2) * 2;
    const outH = Math.round((fh * scale) / 2) * 2;
    pipeline = pipeline.resize(outW, outH, { kernel: 'lanczos3' });
  }

  await pipeline.png().toFile(output);
}

module.exports = { composite, compositeImage };
