"use strict";

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

const { spawn, execFileSync, execFile } = require("child_process");
const chalk = require("chalk");
const ora = require("ora");

const { FRAMES, autoDetect } = require("./frames");
const { getFramePng } = require("./frame-gen");
const { listDevices, getDeviceDimensions } = require("./adb");
const { chooseEncoder } = require("./encoder");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(chalk.red("✖  " + msg));
  process.exit(1);
}

function ffplayAvailable() {
  try {
    execFileSync("ffplay", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function scrcpyAvailable() {
  try {
    execFileSync("scrcpy", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
    w: Math.round((frameWidth * scale) / 2) * 2,
    h: Math.round((frameHeight * scale) / 2) * 2,
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
  const udpUrl = `udp://127.0.0.1:${udpPort}`;
  const { w: dw, h: dh } = previewDisplaySize(
    frameSize.width,
    frameSize.height,
  );

  // Low-latency flags shared by both macOS and Linux ffplay invocations:
  //   -fflags nobuffer  — discard input buffer so frames render immediately
  //   -flags low_delay  — low-delay decoding mode
  //   -framedrop        — drop frames when display falls behind real-time
  //   -analyzeduration 0 / -probesize 32768 — skip the default 5 s stream
  //                       analysis that adds startup latency
  const lowLatencyFlags = [
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-framedrop",
    "-analyzeduration", "0",
    "-probesize", "32768",
  ];

  if (process.platform === "darwin") {
    // Escape single quotes for the shell script passed inside AppleScript
    const safeSh = (s) => s.replace(/'/g, "'\\''");
    // Escape double quotes for the AppleScript string
    const safeAs = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const shellCmd = [
      "ffplay",
      "-fflags nobuffer",
      "-flags low_delay",
      "-framedrop",
      "-analyzeduration 0",
      "-probesize 32768",
      "-f mpegts",
      `-window_title '${safeSh(windowTitle)}'`,
      `-vf scale=${dw}:${dh}`,
      `-x ${dw} -y ${dh}`,
      "-loglevel quiet",
      `'${safeSh(udpUrl)}'`,
    ].join(" ");

    // Multi-expression osascript to set both the command AND the tab title.
    // "do script" returns the Terminal tab object; setting its custom title
    // overrides the default "ffplay" shown in the title bar.
    execFile(
      "osascript",
      [
        "-e",
        'tell application "Terminal"',
        "-e",
        `  set t to do script "${safeAs(shellCmd)}; exit"`,
        "-e",
        `  set custom title of t to "${safeAs(windowTitle)}"`,
        "-e",
        "end tell",
      ],
      () => {},
    ); // fire-and-forget

    return () => {};
  }

  // Linux / other: direct subprocess
  const proc = spawn(
    "ffplay",
    [
      ...lowLatencyFlags,
      "-f", "mpegts",
      "-window_title", windowTitle,
      "-vf", `scale=${dw}:${dh}`,
      "-x", String(dw),
      "-y", String(dh),
      "-loglevel", "quiet",
      udpUrl,
    ],
    { stdio: "ignore" },
  );

  return () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };
}

/**
 * Build the FFmpeg filter graph.
 * Single-pad approach: avoids the double-pad FIFO bug where chaining two
 * pad filters causes FFmpeg to drop all video frames from a pipe source.
 *
 * When speed > 1 (e.g. 1.2), setpts=PTS/speed compresses timestamps so the
 * video plays back faster.  Audio speed is handled separately with atempo.
 */
/**
 * Build the FFmpeg filter graph for live recording.
 *
 * Input 0: raw video pipe (H.264 or MKV from ADB/scrcpy)
 * Input 1: frame PNG   (RGBA, transparent screen hole)
 * Input 2: screen mask (fw×fh grayscale: hole=255, body=0)
 *
 * Steps:
 *   [0:v] scale to screen area → single pad to full frame → format=rgba → [padded]
 *   [padded][2:v] alphamerge → clips video to the frame's screen-hole shape → [base]
 *   [base][1:v]   overlay    → frame chrome on top → [framed]
 *   [framed]      optional scale / speed / yuv420p → [out]
 *
 * Single pad only: avoids the double-pad frame-drop bug on pipe inputs.
 */
function buildFilter(screen, frameSize, scale, speed) {
  const { x: sx, y: sy, width: sw, height: sh } = screen;
  const { width: fw, height: fh } = frameSize;

  const scalePad =
    `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=decrease,` +
    `pad=${fw}:${fh}:${sx}+(${sw}-iw)/2:${sy}+(${sh}-ih)/2,format=rgba[padded]`;

  const applyMask = `[padded][2:v]alphamerge[base]`;

  // eof_action=repeat: keep frame PNG visible until video stream ends.
  const overlay = `[base][1:v]overlay=0:0:eof_action=repeat[framed]`;

  const speedSuffix = speed !== 1 ? `,setpts=PTS/${speed}` : "";

  let finalStep;
  if (scale !== 1) {
    const outW = Math.round((fw * scale) / 2) * 2;
    const outH = Math.round((fh * scale) / 2) * 2;
    finalStep = `;[framed]scale=${outW}:${outH}:flags=lanczos${speedSuffix},format=yuv420p[out]`;
  } else if (speed !== 1) {
    finalStep = `;[framed]setpts=PTS/${speed},format=yuv420p[out]`;
  } else {
    finalStep = `;[framed]format=yuv420p[out]`;
  }

  return `${scalePad};${applyMask};${overlay}${finalStep}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function record(outputPath, options) {
  const serial = options.serial;
  const scheme = options.color || "dark";
  const scale = parseFloat(options.scale || "1");
  const speed = parseFloat(options.speed || "1");
  const crf = parseInt(options.crf || "18", 10);
  const preset = options.preset || "fast";
  const wantDisplay = options.display !== false;
  const useScrcpy = Boolean(options.scrcpy);
  const extraSrArgs = options.screenrecordArgs
    ? options.screenrecordArgs.trim().split(/\s+/)
    : [];

  if (useScrcpy && !scrcpyAvailable()) {
    die("scrcpy not found. Install it: brew install scrcpy");
  }

  // ── Find device ───────────────────────────────────────────────
  const devSpinner = ora("Looking for connected Android device…").start();
  let devices;
  try {
    devices = await listDevices();
  } catch (err) {
    devSpinner.fail(err.message);
    process.exit(1);
  }
  if (devices.length === 0) {
    devSpinner.fail(
      "No Android device found. Connect a device and enable USB debugging.",
    );
    process.exit(1);
  }
  const chosenSerial = serial || devices[0];
  devSpinner.succeed(`Device: ${chosenSerial}`);

  // ── Device dimensions ─────────────────────────────────────────
  const dimSpinner = ora("Reading device screen dimensions…").start();
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
    if (!FRAMES[frameKey]) die(`Unknown frame "${frameKey}". Run: bezl --list`);
    console.log(chalk.dim(`  Frame: ${FRAMES[frameKey].name} (specified)`));
  } else {
    frameKey = autoDetect(dims.width, dims.height);
    console.log(chalk.dim(`  Frame: ${FRAMES[frameKey].name} (auto-detected)`));
  }

  // ── Generate frame PNG ────────────────────────────────────────
  const isRealFrame = FRAMES[frameKey].source === "url";
  const frameSpinner = ora(
    isRealFrame ? "Downloading device frame…" : "Preparing device frame…",
  ).start();
  let framePng, frameSize, screen, screenMaskPath;
  try {
    ({
      pngPath: framePng,
      frameSize,
      screen,
      screenMaskPath,
    } = await getFramePng(frameKey, FRAMES[frameKey], scheme, options.force));
    frameSpinner.succeed(
      `Frame ready (${frameSize.width}×${frameSize.height})`,
    );
  } catch (err) {
    frameSpinner.fail(err.message);
    process.exit(1);
  }

  // ── Resolve display capability ────────────────────────────────
  const showDisplay = wantDisplay && ffplayAvailable();
  if (wantDisplay && !showDisplay) {
    console.log(
      chalk.yellow("  ⚠  ffplay not found — live preview disabled") +
        chalk.dim(" (install ffplay to enable)"),
    );
  }

  // ── Encoder selection ─────────────────────────────────────────
  const encoder = chooseEncoder(preset, crf);

  // ── Build FFmpeg invocation ───────────────────────────────────
  const filter = buildFilter(screen, frameSize, scale, speed);

  // ── Preview UDP stream (only when display is on) ──────────────
  let udpPort = null;
  let stopPreview = () => {};

  if (showDisplay) {
    udpPort = randomUdpPort();
    stopPreview = startPreview(
      udpPort,
      `bezl — ${FRAMES[frameKey].name} (live)`,
      frameSize,
    );
    // Give ffplay a moment to bind to the UDP port before we begin sending frames.
    await new Promise((r) => setTimeout(r, 400));
  }

  const teeOutputs = [`[f=mp4:movflags=+faststart]${outputPath}`];
  if (udpPort) teeOutputs.push(`[f=mpegts]udp://127.0.0.1:${udpPort}`);

  const ffmpegArgs = [
    // Input 0: raw H.264 from ADB screenrecord, or MKV (video+audio) from scrcpy
    ...(useScrcpy
      ? ["-f", "matroska", "-i", "pipe:0"]
      : ["-f", "h264", "-i", "pipe:0"]),
    // Input 1: frame PNG
    "-i", framePng,
    // Input 2: screen clip mask (fw×fh grayscale: hole=255, body=0)
    "-i", screenMaskPath,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    // Audio passthrough — only present when using scrcpy on Android 11+
    // The '?' makes this a no-op when no audio stream exists.
    "-map",
    "0:a?",
    ...encoder.args,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    // Speed up audio to match video when --speed is set
    ...(speed !== 1 ? ["-filter:a", `atempo=${speed}`] : []),
    "-f",
    "tee",
    teeOutputs.join("|"),
  ];

  // ── Status output ─────────────────────────────────────────────
  console.log("");
  console.log(`  ${chalk.dim("Output:")}   ${outputPath}`);
  console.log(
    `  ${chalk.dim("Audio:")}    ${useScrcpy ? "enabled" + chalk.dim(" (Android 11+)") : "disabled" + chalk.dim(" (--scrcpy to enable)")}`,
  );
  console.log(`  ${chalk.dim("Encoder:")}  ${encoder.codec}`);
  if (speed !== 1) {
    console.log(`  ${chalk.dim("Speed:")}    ${speed}×`);
  }
  if (showDisplay) {
    console.log(`  ${chalk.dim("Preview:")}  live window open`);
  }
  console.log("");
  const stopHint = chalk.dim("(no time limit — press Ctrl+C to stop)");
  console.log(chalk.yellow("  Press Ctrl+C to stop.") + " " + stopHint);
  console.log("");

  // ── Countdown (with static-frame preview feed) ────────────────
  if (showDisplay) {
    // While counting down, stream the device frame PNG as a static image so the
    // preview window shows the frame layout before any live video arrives.
    const { w: dw, h: dh } = previewDisplaySize(
      frameSize.width,
      frameSize.height,
    );
    const staticProc = spawn(
      "ffmpeg",
      [
        "-loop",
        "1",
        "-framerate",
        "25",
        "-i",
        framePng,
        "-vf",
        `scale=${dw}:${dh}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mpegts",
        "-loglevel",
        "quiet",
        `udp://127.0.0.1:${udpPort}`,
      ],
      { stdio: "ignore" },
    );

    // Let ffmpeg encode the first frames before the countdown ticks.
    await new Promise((r) => setTimeout(r, 300));

    for (let n = 3; n >= 1; n--) {
      process.stdout.write(
        `\r  ${chalk.yellow("◉")} ${chalk.bold(`Starting in ${n}…`)}   `,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdout.write(
      `\r  ${chalk.red("●")} ${chalk.bold("Recording…")}            \n\n`,
    );

    staticProc.kill();
    // Brief gap so ffplay doesn't close when the static feed drops before live
    // frames arrive from the real recording pipeline.
    await new Promise((r) => setTimeout(r, 200));
  }

  // ── Spawn source process ──────────────────────────────────────

  // FFmpeg: composite frame, encode (hardware if available), write via tee muxer
  const ffmpegProc = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  ffmpegProc.stdin.on("error", () => {});

  // Capture stderr so we can surface a useful message if FFmpeg exits non-zero.
  let ffmpegStderrBuf = "";
  ffmpegProc.stderr.on("data", (chunk) => {
    ffmpegStderrBuf += chunk.toString();
  });

  // Resolves when FFmpeg finishes writing the output file.
  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpegProc.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        const tail = ffmpegStderrBuf.trim().split("\n").slice(-6).join("\n");
        reject(new Error(`FFmpeg exited with code ${code}:\n${tail}`));
      }
    });
    ffmpegProc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html"));
      } else {
        reject(err);
      }
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────

  let stopping = false;

  // sourceDone resolves once the final source process exits (either because the
  // user pressed Ctrl+C, or because scrcpy ended on its own).
  let sourceDone;

  if (useScrcpy) {
    // scrcpy has no time limit — a single process covers the whole session.
    const scrcpyArgs = [
      ...(chosenSerial ? ["-s", chosenSerial] : []),
      "--no-playback",
      "--record=-",
      "--record-format=mkv",
      "--video-codec=h264",
      "--audio-source=output",
      ...extraSrArgs,
    ];
    const sourceProc = spawn("scrcpy", scrcpyArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    sourceProc.stderr.on("data", () => {}); // suppress scrcpy's status logs
    sourceProc.stdout.pipe(ffmpegProc.stdin);

    sourceDone = new Promise((resolve) => {
      sourceProc.on("close", resolve);
      sourceProc.on("error", () => resolve(1));
    });

    process.on("SIGINT", () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(
        `\r  ${chalk.yellow("◎")} ${chalk.bold("Stopping…")}            \n`,
      );
      sourceProc.kill("SIGTERM");
      stopPreview();
    });
  } else {
    // ADB screenrecord has a hard 3-minute limit per invocation.
    // Work around it by auto-restarting the process every time it exits with
    // code 0 (= hit the time limit) and piping the new H.264 stream into the
    // same FFmpeg stdin.  { end: false } keeps the stdin writable across
    // restarts; we close it explicitly when the user stops the recording.
    let currentProc = null;

    sourceDone = new Promise((resolve) => {
      function spawnScreenrecord() {
        const adbArgs = [
          ...(chosenSerial ? ["-s", chosenSerial] : []),
          "exec-out",
          "screenrecord",
          "--output-format=h264",
          ...extraSrArgs,
          "/dev/stdout",
        ];
        currentProc = spawn("adb", adbArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        currentProc.stderr.on("data", () => {});
        // end:false — don't close ffmpegProc.stdin when this process ends
        currentProc.stdout.pipe(ffmpegProc.stdin, { end: false });

        currentProc.on("error", () => {
          ffmpegProc.stdin.end();
          resolve(1);
        });
        currentProc.on("close", (code) => {
          if (!stopping && code === 0) {
            // Hit the 3-minute limit — restart seamlessly.
            // The new stream begins with fresh SPS/PPS headers so FFmpeg
            // resyncs automatically; there may be a single dropped frame.
            spawnScreenrecord();
          } else {
            // User stopped (SIGTERM) or unexpected error — finish up.
            ffmpegProc.stdin.end();
            resolve(code);
          }
        });
      }

      spawnScreenrecord();
    });

    process.on("SIGINT", () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(
        `\r  ${chalk.yellow("◎")} ${chalk.bold("Stopping…")}            \n`,
      );
      if (currentProc) currentProc.kill("SIGTERM");
      stopPreview();
    });
  }

  await sourceDone;
  console.log(`  ${chalk.dim("Recording stopped. Finalizing output…")}`);

  // Wait for FFmpeg to finish writing the file
  const encSpinner = ora("Encoding remaining frames…").start();
  try {
    await ffmpegDone;
    encSpinner.succeed("Done!");
  } catch (err) {
    encSpinner.fail("Encoding failed");
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.green("✔") + "  " + chalk.bold(outputPath));
  console.log("");
}

module.exports = { record };
