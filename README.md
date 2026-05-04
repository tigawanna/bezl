# bezl

wrap android screen recordings in a realistic device frame — post-process
an existing file or record live with the frame applied in real-time.

```
bezl recording.mp4
# → recording-framed.mp4 with a Pixel 7 frame auto-detected
```

## Dependencies

bezl relies on a few system tools. Install them before using bezl.

### macOS (Homebrew)

```bash
# Required — video processing
brew install ffmpeg

# Required for `bezl record` — ADB device communication
brew install android-platform-tools

# Optional — enables audio capture on Android 11+ via `--scrcpy`
brew install scrcpy
```

### Linux

```bash
# Required
sudo apt install ffmpeg adb      # Debian/Ubuntu
sudo dnf install ffmpeg android-tools  # Fedora

# Optional
sudo apt install scrcpy
```

### Node.js

Node.js **18 or later** is required. Check your version with `node -v`.
Install via [nodejs.org](https://nodejs.org) or `brew install node` on macOS.

---

## Install

### Homebrew (macOS, recommended)

```bash
brew tap davidamunga/bezl
brew install bezl
```

This also installs Node.js if you don't already have it. You still need `ffmpeg` and `adb` (see [Dependencies](#dependencies) above).

### npm (global)

```bash
npm install -g @damunga/bezl
```

### Run without installing

```bash
npx @damunga/bezl recording.mp4
```

### From source

```bash
git clone https://github.com/davidamunga/bezl.git
cd bezl
npm install
npm link          # makes `bezl` available globally
```

## Usage

There are two modes: **process** an existing recording, or **record** live with the frame applied in real-time.

### `bezl process <input>` — post-process a recording

```
bezl process <input> [options]

Arguments:
  input                   Path to scrcpy .mp4 / .mkv recording

Options:
  -o, --output <path>     Output file (default: <input>-framed.mp4)
  -f, --frame <name>      Device frame (default: auto-detected)
  -c, --color <scheme>    Frame color: dark | light  (default: dark)
  -s, --scale <factor>    Output scale multiplier, e.g. 0.5 = half size
      --crf <number>      H.264 quality 0–51, lower = better (default: 18)
      --preset <name>     FFmpeg preset: ultrafast→veryslow (default: fast)
      --force             Regenerate frame PNG even if cached
      --list              List available device frames
```

```bash
bezl process recording.mp4
bezl process recording.mp4 --frame samsung-s23
bezl process recording.mp4 --color light --scale 0.5 -o demo.mp4
```

### `bezl record [output]` — live recording

Records from a connected Android device, applies the device frame in
real-time, and shows a **live framed preview** in a window.

```
bezl record [output] [options]

Arguments:
  output                        Output file (default: recording-framed-<timestamp>.mp4)

Options:
      --serial <id>             Target a specific ADB device serial
      --no-display              Disable the live framed preview window
      --scrcpy                  Use scrcpy as source (enables audio on Android 11+)
      --screenrecord-args <s>   Extra args for screenrecord/scrcpy, space-separated
  -f, --frame <name>            Device frame (default: auto-detected from device)
  -c, --color <scheme>          Frame color: dark | light  (default: dark)
  -s, --scale <factor>          Output scale multiplier
      --crf / --preset          libx264 quality (ignored when hardware encoding is used)
```

```bash
# Record with live framed preview — Ctrl+C to stop
bezl record

# With audio (requires scrcpy + Android 11+)
bezl record demo.mp4 --scrcpy

# No preview, limit to 60 seconds
bezl record demo.mp4 --no-display --screenrecord-args "--time-limit=60"

# Specific device
bezl record --serial PT19655JA1222400122
```

**Default pipeline (ADB, video only):**

```
adb exec-out screenrecord --output-format=h264 /dev/stdout
  │  raw H.264 bitstream
  ▼
FFmpeg  [h264_videotoolbox on macOS / libx264 elsewhere]
  │  scale → pad → overlay frame
  ├──► output.mp4          (file on disk)
  └──► UDP:12xxx → ffplay  (live framed preview)
```

**With `--scrcpy` (video + audio):**

```
scrcpy --no-playback --record=- --record-format=mkv
  │  MKV: H.264 video + AAC audio
  ▼
FFmpeg  [same frame overlay + audio passthrough]
  ├──► output.mp4  (video + audio)
  └──► UDP preview
```

**Limitations:**

- scrcpy mode: audio requires Android 11+ and scrcpy 2+, no time limit
- Requires Android 5.0+ (API 21)

## Available frames

| Key           | Device             | Screen resolution |
| ------------- | ------------------ | ----------------- |
| `pixel-7`     | Google Pixel 7     | 1080×2340         |
| `pixel-6`     | Google Pixel 6     | 1080×2400         |
| `samsung-s23` | Samsung Galaxy S23 | 1080×2340         |
| `generic`     | Generic Android    | 1080×1920         |

Auto-detection matches your video's aspect ratio to the closest frame. If your device isn't listed, `pixel-7` works well for most modern 20:9 phones.

## How it works

1. **Frame generation** — each device frame is defined as an SVG with a transparent "screen hole". [sharp](https://sharp.pixelplumbing.com) renders the SVG to a PNG and caches it in `~/.cache/bezl/`.

2. **Video compositing** — FFmpeg:
   - Scales your recording to fit the frame's screen area (letterboxes if the aspect ratios differ slightly).
   - Places the scaled video onto a black canvas at the screen position.
   - Overlays the device frame PNG on top (the transparent hole lets the video show through).
   - Audio is copied through losslessly.

## Adding custom frames

Define a new entry in `src/frames.js` following the existing pattern. The key fields are:

- `screen` — `{ x, y, width, height }` of the transparent screen area within the SVG
- `frameSize` — `{ width, height }` of the overall SVG canvas
- `ratios` — array of `w/h` aspect ratios used for auto-detection
- `build(scheme)` — returns `{ svg, frameSize, screen }` where `svg` is an SVG string with a `<mask>` punching out the screen area
