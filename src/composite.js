'use strict';

const { spawn } = require('child_process');

/**
 * Composite a screen recording with a device frame PNG using FFmpeg.
 *
 * Pipeline:
 *   1. Scale the input video to fit the frame's screen area (letterbox if needed).
 *   2. Pad to the full frame canvas with black.
 *   3. Overlay the frame PNG (which has a transparent screen hole) on top.
 *   4. Optionally scale the whole output by --scale factor.
 *
 * @param {object} opts
 * @param {string}  opts.input       – path to scrcpy recording
 * @param {string}  opts.framePng    – path to generated frame PNG
 * @param {object}  opts.screen      – { x, y, width, height } of screen in frame
 * @param {object}  opts.frameSize   – { width, height } of full frame PNG
 * @param {string}  opts.output      – output file path
 * @param {number}  opts.fps         – source video frame rate
 * @param {boolean} opts.hasAudio    – whether to copy audio
 * @param {number}  [opts.scale=1]   – output scale multiplier (0.5 = half size)
 * @param {number}  [opts.crf=18]    – H.264 CRF quality (0=lossless, 51=worst)
 * @param {string}  [opts.preset='fast'] – FFmpeg encoding preset
 * @param {function} [opts.onProgress]   – called with { percent, time } as encoding progresses
 */
async function composite(opts) {
  const {
    input,
    framePng,
    screen,
    frameSize,
    output,
    fps,
    hasAudio,
    scale    = 1,
    crf      = 18,
    preset   = 'fast',
    onProgress,
  } = opts;

  const { x: sx, y: sy, width: sw, height: sh } = screen;
  const { width: fw, height: fh } = frameSize;

  // Final output dimensions after applying --scale
  const outW = Math.round(fw * scale / 2) * 2; // keep even for H.264
  const outH = Math.round(fh * scale / 2) * 2;

  /*
   * Filter graph explanation:
   *
   * [0:v] → scale to fit within the screen area (letterbox, AR preserved)
   *       → single pad to the full frame canvas, centering the video
   *         within the screen area: x = sx + (sw - iw)/2, y = sy + (sh - ih)/2
   *       → [base]
   *
   * [1:v] = frame PNG (RGBA, transparent screen hole)
   *
   * [base][1:v] overlay=0:0 → frame chrome sits on top of video
   *
   * If scale ≠ 1, add a final rescale step.
   *
   * NOTE: We deliberately avoid chaining two pad filters — a double-pad chain
   * causes FFmpeg to drop all video frames when reading from a named pipe
   * (FIFO), which is used by the live `record` command.
   */

  // Step 1: scale + single pad (centers video within screen, expands to full frame)
  const scaleAndPad = [
    `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=decrease`,
    `pad=${fw}:${fh}:${sx}+(${sw}-iw)/2:${sy}+(${sh}-ih)/2:black[base]`,
  ].join(',');

  // Step 2: overlay frame PNG (alpha-aware)
  // shortest=1 breaks video output when audio is present in a FIFO pipe.
  // eof_action=repeat keeps the frame PNG visible until the video stream ends.
  const overlayFrame = `[base][1:v]overlay=0:0:eof_action=repeat[framed]`;

  // Step 3: optional rescale
  const finalScale =
    scale !== 1
      ? `;[framed]scale=${outW}:${outH}:flags=lanczos[out]`
      : `;[framed]copy[out]`;

  const filterComplex = `${scaleAndPad};${overlayFrame}${finalScale}`;

  const args = [
    '-i', input,
    '-i', framePng,
    '-filter_complex', filterComplex,
    '-map', '[out]',
  ];

  if (hasAudio) {
    args.push('-map', '0:a?', '-c:a', 'copy');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',  // broad compatibility
    '-movflags', '+faststart',
    '-y',                    // overwrite output
    output,
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);

    let stderrBuf = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;

      if (onProgress) {
        // Parse "time=HH:MM:SS.ss" from FFmpeg progress output
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
        // Surface the last few lines of stderr for a useful error message
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

module.exports = { composite };
