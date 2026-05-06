'use strict';

const { execFileSync } = require('child_process');

/**
 * Detect the fastest available H.264 encoder.
 *
 * On macOS, h264_videotoolbox uses the hardware video encoder (Apple Silicon
 * or Intel QuickSync) and is 5-10× faster than software libx264. It does not
 * support CRF so a target bitrate (8 Mbps) is used instead.
 *
 * @param {string} preset  – libx264 preset (ignored when hardware encoding is used)
 * @param {number} crf     – libx264 CRF value (ignored when hardware encoding is used)
 * @returns {{ codec: string, args: string[] }}
 */
function chooseEncoder(preset, crf) {
  if (process.platform === 'darwin') {
    try {
      execFileSync(
        'ffmpeg',
        [
          '-f', 'lavfi',
          '-i', 'color=black:size=2x2:rate=1:duration=0.04',
          '-c:v', 'h264_videotoolbox',
          '-f', 'null',
          '-',
        ],
        { stdio: 'ignore' },
      );
      return {
        codec: 'h264_videotoolbox',
        args: ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-allow_sw', '1'],
      };
    } catch {
      /* fall through to libx264 */
    }
  }
  return {
    codec: 'libx264',
    args: ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)],
  };
}

module.exports = { chooseEncoder };
