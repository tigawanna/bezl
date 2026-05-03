'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Run ffprobe on an input file and return parsed video stream metadata.
 *
 * @param {string} inputPath
 * @returns {Promise<{ width, height, fps, hasAudio, duration }>}
 */
async function probe(inputPath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      inputPath,
    ]));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'ffprobe not found. Install FFmpeg: https://ffmpeg.org/download.html'
      );
    }
    throw new Error(`ffprobe failed: ${err.message}`);
  }

  const info = JSON.parse(stdout);
  const streams = info.streams || [];

  const video = streams.find(s => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found in input file.');

  const hasAudio = streams.some(s => s.codec_type === 'audio');

  // Parse frame rate — stored as "30000/1001" or "30/1"
  let fps = 30;
  const fpsStr = video.avg_frame_rate || video.r_frame_rate || '30/1';
  const [num, den] = fpsStr.split('/').map(Number);
  if (den && den !== 0) fps = num / den;

  // Duration in seconds
  const duration = parseFloat(info.format?.duration || video.duration || '0');

  return {
    width: video.width,
    height: video.height,
    fps: Math.round(fps * 100) / 100, // round to 2 dp
    hasAudio,
    duration,
  };
}

module.exports = { probe };
