# bezl

## 0.1.0

### Minor Changes

- The `bezl process` command now accepts static images (`.png`, `.jpg`, `.jpeg`, `.webp`) in addition to video files. Images are composited into the device frame using Sharp — no FFmpeg required for image inputs.

- Add `bezl screenshot [output]` command that captures a screenshot directly from a connected Android device via ADB and immediately composites it into the device frame — no intermediate files required.

### Patch Changes

- Use hardware-accelerated H.264 encoding (`h264_videotoolbox`) on macOS in both the `record` and `process` commands. Falls back to `libx264` when the hardware encoder is unavailable.

- Fix crash in `record` mode where `ffmpegDone` was referenced before being defined, causing recordings to always fail with an unhandled promise rejection.

- Fix screenshot content bleeding outside the device frame at the top corners. The screen bbox coordinates extend slightly beyond the phone body at the topmost rows; the compositing mask now scans each row's actual phone-body bounds and zeroes out any content that falls in the transparent background region.

## 0.0.4

### Patch Changes

- add homebrew tap update to ci

## 0.0.3

### Patch Changes

- auto-restart screenrecord on the 3-minute time-limit exit so ADB recordings run indefinitely

- add optional speed flag to cli

## 0.0.2

### Patch Changes

- initial release
