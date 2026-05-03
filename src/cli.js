'use strict';

const fs      = require('fs');
const path    = require('path');
const { program } = require('commander');
const chalk   = require('chalk');
const ora     = require('ora');

const { FRAMES, autoDetect } = require('./frames');
const { getFramePng, CACHE_DIR } = require('./frame-gen');
const { probe } = require('./probe');
const { composite } = require('./composite');
const { record } = require('./record');

const pkg = require('../package.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(chalk.red('✖  ' + msg));
  process.exit(1);
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function defaultOutput(inputPath) {
  const ext  = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  const dir  = path.dirname(inputPath);
  return path.join(dir, `${base}-framed${ext}`);
}

// ─── List frames command ───────────────────────────────────────────────────────

function frameInfo(f) {
  if (f.source === 'url') {
    const c = f.colors.dark;
    return { frameSize: c.frameSize, screen: c.screen };
  }
  const built = f.build('dark');
  return { frameSize: built.frameSize, screen: built.screen };
}

function listFrames() {
  const realFrames = Object.entries(FRAMES).filter(([, f]) => f.source === 'url');
  const svgFrames  = Object.entries(FRAMES).filter(([, f]) => f.source !== 'url');

  console.log('');
  console.log(chalk.bold('Available device frames:'));
  console.log('');

  if (realFrames.length) {
    console.log(chalk.bold.green('  Real device frames (photo-quality PNG):'));
    console.log('');
    for (const [key, f] of realFrames) {
      const { frameSize: { width: fw, height: fh }, screen } = frameInfo(f);
      console.log(`  ${chalk.cyan(key.padEnd(18))}  ${chalk.white(f.name)}`);
      console.log(`  ${' '.repeat(18)}  ${chalk.dim(f.desc)}`);
      console.log(`  ${' '.repeat(18)}  ${chalk.dim(`Frame: ${fw}×${fh}  Screen area: ${screen.width}×${screen.height}`)}`);
      console.log('');
    }
  }

  if (svgFrames.length) {
    console.log(chalk.bold.yellow('  SVG-generated frames (vector, no download):'));
    console.log('');
    for (const [key, f] of svgFrames) {
      const { frameSize: { width: fw, height: fh }, screen } = frameInfo(f);
      console.log(`  ${chalk.cyan(key.padEnd(18))}  ${chalk.white(f.name)}`);
      console.log(`  ${' '.repeat(18)}  ${chalk.dim(f.desc)}`);
      console.log(`  ${' '.repeat(18)}  ${chalk.dim(`Frame: ${fw}×${fh}  Screen area: ${screen.width}×${screen.height}`)}`);
      console.log('');
    }
  }
}

// ─── Main action ──────────────────────────────────────────────────────────────

async function run(inputPath, options) {
  // ── Validate input ──────────────────────────────────────────────
  if (!fs.existsSync(inputPath)) {
    die(`Input file not found: ${inputPath}`);
  }

  const outputPath = options.output || defaultOutput(inputPath);

  // ── Probe video ─────────────────────────────────────────────────
  const probeSpinner = ora('Reading video metadata…').start();
  let meta;
  try {
    meta = await probe(inputPath);
    probeSpinner.succeed(
      `${meta.width}×${meta.height} · ${meta.fps} fps · ` +
      `${formatDuration(meta.duration)} · ` +
      (meta.hasAudio ? 'audio ✓' : 'no audio')
    );
  } catch (err) {
    probeSpinner.fail(err.message);
    process.exit(1);
  }

  // ── Select frame ────────────────────────────────────────────────
  let frameKey = options.frame;
  if (frameKey) {
    if (!FRAMES[frameKey]) {
      die(
        `Unknown frame "${frameKey}". ` +
        `Run ${chalk.cyan('bezl --list')} to see available frames.`
      );
    }
    console.log(chalk.dim(`  Frame: ${FRAMES[frameKey].name} (specified)`));
  } else {
    frameKey = autoDetect(meta.width, meta.height);
    console.log(
      chalk.dim(`  Frame: ${FRAMES[frameKey].name} (auto-detected for ${meta.width}×${meta.height})`)
    );
  }

  const frameDef = FRAMES[frameKey];
  const scheme   = options.color || 'dark';

  // ── Generate / fetch frame PNG ───────────────────────────────────
  const isRealFrame = frameDef.source === 'url';
  const frameSpinner = ora(
    isRealFrame ? 'Downloading device frame…' : 'Preparing device frame…'
  ).start();
  let framePng, frameSize, screen;
  try {
    ({ pngPath: framePng, frameSize, screen } = await getFramePng(
      frameKey,
      frameDef,
      scheme,
      options.force,
    ));
    frameSpinner.succeed(`Frame ready (${frameSize.width}×${frameSize.height})`);
  } catch (err) {
    frameSpinner.fail(`Frame generation failed: ${err.message}`);
    process.exit(1);
  }

  // ── Composite ───────────────────────────────────────────────────
  console.log('');
  console.log(
    `  ${chalk.dim('Input:')}   ${inputPath}`
  );
  console.log(
    `  ${chalk.dim('Output:')}  ${outputPath}`
  );
  console.log('');

  const encodeSpinner = ora('Encoding…').start();
  const scale   = parseFloat(options.scale || '1');
  const crf     = parseInt(options.crf || '18', 10);
  const preset  = options.preset || 'fast';

  try {
    await composite({
      input:    inputPath,
      framePng,
      screen,
      frameSize,
      output:   outputPath,
      fps:      meta.fps,
      hasAudio: meta.hasAudio,
      scale,
      crf,
      preset,
      onProgress: ({ elapsed }) => {
        if (meta.duration > 0) {
          const pct = Math.min(100, Math.round((elapsed / meta.duration) * 100));
          encodeSpinner.text = `Encoding… ${pct}% (${formatDuration(elapsed)} / ${formatDuration(meta.duration)})`;
        } else {
          encodeSpinner.text = `Encoding… ${formatDuration(elapsed)}`;
        }
      },
    });

    encodeSpinner.succeed('Done!');
    console.log('');
    console.log(
      chalk.green('✔') + '  ' + chalk.bold(outputPath)
    );
    console.log('');
  } catch (err) {
    encodeSpinner.fail('Encoding failed');
    console.error('');
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

// Shared options used by both the default command and the record subcommand
const sharedOptions = (cmd) =>
  cmd
    .option('-f, --frame <name>',    'Device frame to use (default: auto-detect)')
    .option('-c, --color <scheme>',  'Frame color: dark | light', 'dark')
    .option('-s, --scale <factor>',  'Output scale multiplier, e.g. 0.5 for half size', '1')
    .option('--crf <number>',        'libx264 quality: 0=lossless 51=worst (default: 18)', '18')
    .option('--preset <name>',       'libx264 preset (ignored when hardware encoding is used)', 'fast')
    .option('--force',               'Regenerate frame PNG even if cached');

program
  .name('bezl')
  .description('Add device frames to Android screen recordings')
  .version(pkg.version);

// ── Default command: post-process an existing recording ───────────────────────
sharedOptions(
  program
    .command('process <input>', { isDefault: true })
    .description('Add a device frame to an existing screen recording')
    .option('-o, --output <path>', 'Output file path (default: <input>-framed.mp4)')
    .option('--list',              'List available device frames and exit')
).action(async (inputPath, options) => {
  if (options.list) { listFrames(); return; }
  await run(inputPath, options);
});

// ── record subcommand: live recording ─────────────────────────────────────────
sharedOptions(
  program
    .command('record [output]')
    .description(
      'Record from a connected Android device with a live framed preview.\n' +
      'Default source: adb screenrecord (video only, no time limit issues).\n' +
      'Use --scrcpy for audio capture (requires Android 11+ and scrcpy 2+).'
    )
    .option('--serial <id>',   'Target a specific device by ADB serial')
    .option('--no-display',    'Disable the live framed preview window')
    .option('--scrcpy',        'Use scrcpy as source — enables audio on Android 11+ (requires scrcpy)')
    .option(
      '--screenrecord-args <args>',
      'Extra args passed to screenrecord or scrcpy, space-separated'
    )
).action(async (output, options) => {
  const outputPath = output || `recording-framed-${Date.now()}.mp4`;
  await record(outputPath, options);
});

// ── Top-level --list shortcut (no subcommand required) ────────────────────────
if (process.argv.includes('--list')) {
  listFrames();
  process.exit(0);
}

program.parse(process.argv);
