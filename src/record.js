'use strict';

/**
 * Live recording mode — two source modes selectable via --scrcpy flag.
 *
 * ── ADB mode (default) ──────────────────────────────────────────────────────
 *
 *   adb exec-out screenrecord --output-format=h264 /dev/stdout
 *     │  raw H.264 stream — video only (Android's screenrecord has no audio)
 *     ▼
 *   ffmpeg  -f h264 -i pipe:0  -i frame.png
 *     │  filter: scale → pad → overlay frame
 *     ├──► [f=mp4:movflags=+faststart]  output.mp4  (recorded file)
 *     └──► [f=mpegts]udp://127.0.0.1:<port>         (live preview)
 *
 * ── scrcpy mode (--scrcpy) — video + audio ──────────────────────────────────
 *
 *   scrcpy --no-playback --record=- --record-format=mkv
 *     │  MKV container: H.264 video + AAC audio on Android 11+ (scrcpy 2+)
 *     ▼
 *   ffmpeg  -f matroska -i pipe:0  -i frame.png
 *     │  filter: scale → pad → overlay frame (video)
 *     │  -map 0:a?  -c:a aac  (audio passthrough, silent no-op if absent)
 *     ├──► [f=mp4:movflags=+faststart]  output.mp4  (video + audio)
 *     └──► [f=mpegts]udp://127.0.0.1:<port>         (live preview)
 *
 * Recording pipeline:
 *
 *   adb exec-out screenrecord --output-format=h264 /dev/stdout
 *     │  (raw H.264 bitstream, no container)
 *     ▼
 *   ffmpeg  -f h264 -i pipe:0  -i frame.png
 *     │  filter: scale → pad → overlay frame
 *     ├──► [f=mp4:movflags=+faststart]  output.mp4      (recorded file)
 *     └──► [f=mpegts]udp://127.0.0.1:<port>           (live preview stream)
 *                          │
 *                          ▼
 *                   ffplay -f mpegts udp://127.0.0.1:<port>
 *                    ↑
 *    macOS: launched via osascript in a new Terminal window
 *           (Node.js child processes exit with SDL error 123 on macOS —
 *            no window server access without a proper NSApplication context)
 *    Linux: spawned directly as a subprocess
 *
 * Why UDP instead of a named FIFO:
 *   A FIFO blocks FFmpeg from opening its outputs until ffplay connects.
 *   Meanwhile, ADB is writing video into a 64KB pipe buffer. Once the buffer
 *   fills, ADB blocks too. By the time ffplay opens the FIFO, most of the
 *   recording has been lost. UDP has no connection semantics — FFmpeg sends
 *   immediately and ffplay can join at any time (missing early frames is fine
 *   for a preview). This also means the tee muxer no longer blocks the start
 *   of the recording pipeline.
 *
 * Encoding:
 *  • macOS: h264_videotoolbox (Apple hardware encoder, ~5-10× faster than
 *    libx264). Falls back to libx264 if videotoolbox is unavailable.
 *  • Other platforms: libx264 software encoding.
 *
 * Display (live preview):
 *  • Preview is sent as MPEG-TS over UDP (no blocking, ffplay can join late).
 *  • macOS: ffplay is launched via osascript in a new Terminal window because
 *    Node.js child processes exit immediately with SDL2 error 123 (no window
 *    server access without an NSApplication context).
 *  • Linux: ffplay is spawned directly as a subprocess.
 *
 * Why UDP instead of a FIFO for preview:
 *  • A FIFO blocks FFmpeg from opening its outputs until ffplay connects.
 *    ADB meanwhile fills a 64KB pipe buffer and blocks. Most of the recording
 *    is lost before the FIFO unblocks. UDP has no connection semantics —
 *    FFmpeg writes immediately and ffplay can join at any time.
 *
 * Audio notes:
 *  • ADB mode: video only. Android's `screenrecord` has no audio API.
 *  • scrcpy mode: audio available on Android 11+ with scrcpy 2+.
 *    Use --audio-source=output to capture device audio output.
 *    Requires `scrcpy` to be installed (brew install scrcpy on macOS).
 */

const { spawn, execFileSync, execFile } = require('child_process');
const chalk = require('chalk');
const ora   = require('ora');

const { FRAMES, autoDetect }               = require('./frames');
const { getFramePng }                      = require('./frame-gen');
const { listDevices, getDeviceDimensions } = require('./adb');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(chalk.red('✖  ' + msg));
  process.exit(1);
}

function ffplayAvailable() {
  try { execFileSync('ffplay', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function scrcpyAvailable() {
  try { execFileSync('scrcpy', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/**
 * Detect the fastest available H.264 encoder.
 *
 * On macOS, h264_videotoolbox uses the hardware video encoder (Apple Silicon
 * or Intel QuickSync) and is 5-10× faster than software libx264. It doesn't
 * support CRF so we use a target bitrate (8 Mbps) instead.
 *
 * Returns { codec, args } where args are the encoder-specific FFmpeg flags
 * (excluding -pix_fmt yuv420p which is always appended separately).
 */
function chooseEncoder(preset, crf) {
  if (process.platform === 'darwin') {
    try {
      execFileSync('ffmpeg', [
        '-f', 'lavfi', '-i', 'color=black:size=2x2:rate=1:duration=0.04',
        '-c:v', 'h264_videotoolbox', '-f', 'null', '-',
      ], { stdio: 'ignore' });
      return {
        codec: 'h264_videotoolbox',
        args:  ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-allow_sw', '1'],
      };
    } catch { /* fall through */ }
  }
  return {
    codec: 'libx264',
    args:  ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)],
  };
}

function randomUdpPort() {
  return 12000 + Math.floor(Math.random() * 1000);
}

/**
 * Calculate a sensible display size for the preview window.
 * Targets a max height of 820px (fits comfortably on a 1080p screen) while
 * preserving the frame's aspect ratio. Width is always even (H.264 requirement).
 */
function previewDisplaySize(frameWidth, frameHeight) {
  const maxH = 820;
  const scale = Math.min(1, maxH / frameHeight);
  return {
    w: Math.round(frameWidth  * scale / 2) * 2,
    h: Math.round(frameHeight * scale / 2) * 2,
  };
}

/**
 * Start the ffplay preview window reading from a UDP port.
 *
 * Streams MPEG-TS over UDP (127.0.0.1:<port>) from the tee muxer.
 * UDP has no connection semantics — FFmpeg sends immediately, ffplay can
 * join at any time.
 *
 * frameSize is used to scale the preview window proportionally so it fits
 * a normal laptop screen without overflowing.
 *
 * On macOS, spawning ffplay directly as a Node.js child exits immediately
 * with code 123 (SDL2 can't open a window without NSApplication context).
 * Fix: use osascript to open a Terminal window with a custom title, which
 * gives ffplay a proper macOS GUI context and sets a meaningful title bar.
 *
 * On Linux, ffplay is spawned directly as a subprocess.
 */
function startPreview(udpPort, windowTitle, frameSize) {
  const udpUrl   = `udp://127.0.0.1:${udpPort}`;
  const { w: dw, h: dh } = previewDisplaySize(frameSize.width, frameSize.height);

  if (process.platform === 'darwin') {
    // Escape single quotes for the shell script passed inside AppleScript
    const safeSh  = (s) => s.replace(/'/g, "'\\''");
    // Escape double quotes for the AppleScript string
    const safeAs  = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const shellCmd = [
      'ffplay',
      '-f', 'mpegts',
      `-window_title '${safeSh(windowTitle)}'`,
      `-vf scale=${dw}:${dh}`,       // scale down to fit the screen
      `-x ${dw} -y ${dh}`,           // fix the SDL window size
      '-loglevel quiet',
      `'${safeSh(udpUrl)}'`,
    ].join(' ');

    // Multi-expression osascript to set both the command AND the tab title.
    // "do script" returns the Terminal tab object; setting its custom title
    // overrides the default "ffplay" shown in the title bar.
    execFile('osascript', [
      '-e', 'tell application "Terminal"',
      '-e', `  set t to do script "${safeAs(shellCmd)}; exit"`,
      '-e', `  set custom title of t to "${safeAs(windowTitle)}"`,
      '-e', 'end tell',
    ], () => {}); // fire-and-forget

    return () => {};
  }

  // Linux / other: direct subprocess
  const proc = spawn('ffplay', [
    '-f', 'mpegts',
    '-window_title', windowTitle,
    '-vf', `scale=${dw}:${dh}`,
    '-x', String(dw), '-y', String(dh),
    '-loglevel', 'quiet',
    udpUrl,
  ], { stdio: 'ignore' });

  return () => { try { proc.kill(); } catch { /* ignore */ } };
}

/**
 * Build the FFmpeg filter graph.
 * Single-pad approach: avoids the double-pad FIFO bug where chaining two
 * pad filters causes FFmpeg to drop all video frames from a pipe source.
 */
function buildFilter(screen, frameSize, scale) {
  const { x: sx, y: sy, width: sw, height: sh } = screen;
  const { width: fw, height: fh } = frameSize;

  const scalePad =
    `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=decrease,` +
    `pad=${fw}:${fh}:${sx}+(${sw}-iw)/2:${sy}+(${sh}-ih)/2[base]`;

  // eof_action=repeat: keep frame PNG visible until video stream ends.
  // (shortest=1 causes video loss when audio is also present in the pipe.)
  const overlay = `[base][1:v]overlay=0:0:eof_action=repeat[framed]`;

  if (scale !== 1) {
    const outW = Math.round(fw * scale / 2) * 2;
    const outH = Math.round(fh * scale / 2) * 2;
    return `${scalePad};${overlay};[framed]scale=${outW}:${outH}:flags=lanczos[out]`;
  }
  return `${scalePad};${overlay};[framed]copy[out]`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function record(outputPath, options) {
  const serial      = options.serial;
  const scheme      = options.color  || 'dark';
  const scale       = parseFloat(options.scale  || '1');
  const crf         = parseInt(options.crf    || '18', 10);
  const preset      = options.preset || 'fast';
  const wantDisplay = options.display !== false;
  const useScrcpy   = Boolean(options.scrcpy);
  const extraSrArgs = options.screenrecordArgs
    ? options.screenrecordArgs.trim().split(/\s+/)
    : [];

  if (useScrcpy && !scrcpyAvailable()) {
    die('scrcpy not found. Install it: brew install scrcpy');
  }

  // ── Find device ───────────────────────────────────────────────
  const devSpinner = ora('Looking for connected Android device…').start();
  let devices;
  try {
    devices = await listDevices();
  } catch (err) {
    devSpinner.fail(err.message);
    process.exit(1);
  }
  if (devices.length === 0) {
    devSpinner.fail(
      'No Android device found. Connect a device and enable USB debugging.'
    );
    process.exit(1);
  }
  const chosenSerial = serial || devices[0];
  devSpinner.succeed(`Device: ${chosenSerial}`);

  // ── Device dimensions ─────────────────────────────────────────
  const dimSpinner = ora('Reading device screen dimensions…').start();
  let dims;
  try {
    dims = await getDeviceDimensions(chosenSerial);
    dimSpinner.succeed(`Screen: ${dims.width}×${dims.height}`);
  } catch (err) {
    dimSpinner.fail(err.message);
    process.exit(1);
  }

  // ── Frame selection ───────────────────────────────────────────
  let frameKey = options.frame;
  if (frameKey) {
    if (!FRAMES[frameKey]) die(`Unknown frame "${frameKey}". Run: phonebox --list`);
    console.log(chalk.dim(`  Frame: ${FRAMES[frameKey].name} (specified)`));
  } else {
    frameKey = autoDetect(dims.width, dims.height);
    console.log(chalk.dim(`  Frame: ${FRAMES[frameKey].name} (auto-detected)`));
  }

  // ── Generate frame PNG ────────────────────────────────────────
  const isRealFrame = FRAMES[frameKey].source === 'url';
  const frameSpinner = ora(
    isRealFrame ? 'Downloading device frame…' : 'Preparing device frame…'
  ).start();
  let framePng, frameSize, screen;
  try {
    ({ pngPath: framePng, frameSize, screen } =
      await getFramePng(frameKey, FRAMES[frameKey], scheme, options.force));
    frameSpinner.succeed(`Frame ready (${frameSize.width}×${frameSize.height})`);
  } catch (err) {
    frameSpinner.fail(err.message);
    process.exit(1);
  }

  // ── Resolve display capability ────────────────────────────────
  const showDisplay = wantDisplay && ffplayAvailable();
  if (wantDisplay && !showDisplay) {
    console.log(
      chalk.yellow('  ⚠  ffplay not found — live preview disabled') +
      chalk.dim(' (install ffplay to enable)')
    );
  }

  // ── Preview UDP stream (only when display is on) ──────────────
  let udpPort     = null;
  let stopPreview = () => {};

  if (showDisplay) {
    udpPort = randomUdpPort();
    stopPreview = startPreview(
      udpPort,
      `phonebox — ${FRAMES[frameKey].name} (live)`,
      frameSize
    );
    // Give ffplay a moment to start listening before FFmpeg begins sending.
    // UDP is fire-and-forget, so this is just a courtesy — no blocking on either end.
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Encoder selection ─────────────────────────────────────────
  const encoder = chooseEncoder(preset, crf);

  // ── Build FFmpeg invocation ───────────────────────────────────
  const filter = buildFilter(screen, frameSize, scale);

  const teeOutputs = [`[f=mp4:movflags=+faststart]${outputPath}`];
  if (udpPort) teeOutputs.push(`[f=mpegts]udp://127.0.0.1:${udpPort}`);

  const ffmpegArgs = [
    // Input: raw H.264 from ADB screenrecord, or MKV (video+audio) from scrcpy
    ...(useScrcpy
      ? ['-f', 'matroska', '-i', 'pipe:0']
      : ['-f', 'h264',     '-i', 'pipe:0']),
    '-i', framePng,
    '-filter_complex', filter,
    '-map', '[out]',
    // Audio passthrough — only present when using scrcpy on Android 11+
    // The '?' makes this a no-op when no audio stream exists.
    '-map', '0:a?',
    ...encoder.args,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'tee', teeOutputs.join('|'),
  ];

  // ── Status output ─────────────────────────────────────────────
  const audioNote = useScrcpy ? chalk.dim(' (audio via scrcpy)') : chalk.yellow(' (video only — use --scrcpy for audio)');
  const encoderNote = chalk.dim(` [${encoder.codec}]`);

  console.log('');
  console.log(`  ${chalk.dim('Output:')}   ${outputPath}`);
  console.log(`  ${chalk.dim('Audio:')}    ${useScrcpy ? 'enabled' + chalk.dim(' (Android 11+)') : 'disabled' + chalk.dim(' (--scrcpy to enable)')}`);
  console.log(`  ${chalk.dim('Encoder:')}  ${encoder.codec}`);
  if (showDisplay) {
    console.log(`  ${chalk.dim('Preview:')}  live window opening…`);
  }
  console.log('');
  const stopHint = useScrcpy
    ? chalk.dim('(no time limit with scrcpy)')
    : chalk.dim('(screenrecord stops automatically after 3 min)');
  console.log(chalk.yellow('  Press Ctrl+C to stop.') + ' ' + stopHint);
  console.log('');

  // ── Spawn source process ──────────────────────────────────────

  let sourceProc;

  if (useScrcpy) {
    // scrcpy 3.x: --no-playback replaces --no-display
    const scrcpyArgs = [
      ...(chosenSerial ? ['-s', chosenSerial] : []),
      '--no-playback',
      '--record=-',
      '--record-format=mkv',
      '--video-codec=h264',
      '--audio-source=output',
      ...extraSrArgs,
    ];
    sourceProc = spawn('scrcpy', scrcpyArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sourceProc.stderr.on('data', () => {}); // suppress scrcpy's status logs
  } else {
    const adbArgs = [
      ...(chosenSerial ? ['-s', chosenSerial] : []),
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      ...extraSrArgs,
      '/dev/stdout',
    ];
    sourceProc = spawn('adb', adbArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sourceProc.stderr.on('data', () => {});
  }

  // FFmpeg: composite frame, encode (hardware if available), write via tee muxer
  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  sourceProc.stdout.pipe(ffmpegProc.stdin);
  ffmpegProc.stdin.on('error', () => {});

  const recSpinner = ora('Recording…').start();

  // ── Lifecycle ─────────────────────────────────────────────────

  const sourceDone = new Promise(resolve => {
    sourceProc.on('close', resolve);
    sourceProc.on('error', () => resolve(1));
  });

  const ffmpegDone = new Promise((resolve, reject) => {
    let stderr = '';
    ffmpegProc.stderr.on('data', c => { stderr += c.toString(); });
    ffmpegProc.on('close', code => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(
        `FFmpeg exited with code ${code}:\n` +
        stderr.trim().split('\n').slice(-5).join('\n')
      ));
    });
    ffmpegProc.on('error', reject);
  });

  // Ctrl+C: stop source; FFmpeg drains remaining frames and closes the file
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    recSpinner.text = 'Stopping recording…';
    sourceProc.kill('SIGTERM');
    stopPreview();
  });

  await sourceDone;
  recSpinner.succeed('Recording stopped. Finalizing output…');

  // Wait for FFmpeg to finish writing the file
  const encSpinner = ora('Encoding remaining frames…').start();
  try {
    await ffmpegDone;
    encSpinner.succeed('Done!');
  } catch (err) {
    encSpinner.fail('Encoding failed');
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green('✔') + '  ' + chalk.bold(outputPath));
  console.log('');
}

module.exports = { record };
