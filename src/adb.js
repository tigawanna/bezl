'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Run an adb command and return stdout.
 * Throws a friendly error if adb is not found.
 */
async function adb(args, serial) {
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  try {
    const { stdout } = await execFileAsync('adb', fullArgs);
    return stdout.trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'adb not found. Install Android Platform Tools:\n' +
        '  brew install android-platform-tools\n' +
        '  https://developer.android.com/studio/releases/platform-tools'
      );
    }
    throw new Error(`adb error: ${err.stderr || err.message}`);
  }
}

/**
 * Return a list of connected device serials.
 */
async function listDevices() {
  const out = await adb(['devices']);
  return out
    .split('\n')
    .slice(1)
    .filter(line => line.includes('\tdevice'))
    .map(line => line.split('\t')[0].trim());
}

/**
 * Get the physical screen dimensions of the connected device.
 * Returns { width, height } in pixels.
 */
async function getDeviceDimensions(serial) {
  const out = await adb(['shell', 'wm', 'size'], serial);
  // Output: "Physical size: 1080x2340"
  // Or with override: "Override size: 540x1170\nPhysical size: 1080x2340"
  const match = out.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    // Fallback: first number pair
    const fallback = out.match(/(\d+)x(\d+)/);
    if (!fallback) throw new Error(`Unexpected wm size output: ${out}`);
    return { width: parseInt(fallback[1]), height: parseInt(fallback[2]) };
  }
  return { width: parseInt(match[1]), height: parseInt(match[2]) };
}

module.exports = { adb, listDevices, getDeviceDimensions };
