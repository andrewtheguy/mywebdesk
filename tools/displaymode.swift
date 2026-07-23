// displaymode — list or set the main display's resolution.
//
// macOS Screen Sharing ignores the RFB SetDesktopSize request, so remotex
// can't resize its display from the browser. Run this on the Mac manually
// (locally or over SSH) to change the resolution; the new size reaches the
// browser as a normal VNC desktop-size update.
//
//   displaymode list
//   displaymode set <width> <height>
//
// `set` picks the largest usable mode that fits within the requested size
// (so the remote desktop never overflows the browser viewport); if nothing
// fits it picks the smallest mode overall.
//
// Build on the Mac (needs Command Line Tools):
//   swiftc -O -o ~/.local/bin/displaymode displaymode.swift

import CoreGraphics
import Foundation

func describe(_ mode: CGDisplayMode) -> String {
  let hidpi = mode.pixelWidth != mode.width ? " hidpi" : ""
  let usable = mode.isUsableForDesktopGUI() ? "" : " unusable"
  return
    "\(mode.width)x\(mode.height) px:\(mode.pixelWidth)x\(mode.pixelHeight) @\(Int(mode.refreshRate))Hz\(hidpi)\(usable)"
}

let display = CGMainDisplayID()
let options =
  [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue!] as CFDictionary

guard
  let allModes = CGDisplayCopyAllDisplayModes(display, options)
    as? [CGDisplayMode]
else {
  FileHandle.standardError.write(Data("error: cannot list modes\n".utf8))
  exit(1)
}

let args = CommandLine.arguments

if args.count == 2 && args[1] == "list" {
  if let current = CGDisplayCopyDisplayMode(display) {
    print("current \(describe(current))")
  }
  for mode in allModes {
    print(describe(mode))
  }
  exit(0)
}

if args.count == 4 && args[1] == "set", let width = Int(args[2]),
  let height = Int(args[3])
{
  let usable = allModes.filter { $0.isUsableForDesktopGUI() }
  guard !usable.isEmpty else {
    FileHandle.standardError.write(Data("error: no usable modes\n".utf8))
    exit(1)
  }

  // The duplicate-modes list contains 64-bit HDR variants of each resolution
  // that a virtual display can refuse to apply (CGCompleteDisplayConfiguration
  // returns .noneAvailable). The public API no longer exposes bit depth, so
  // sniff it from the mode's description and prefer 32-bit variants.
  func is32Bit(_ mode: CGDisplayMode) -> Bool {
    return String(describing: mode).contains("BitsPerPixel = 32")
  }

  // Rank: modes that fit within the target come first (largest area wins);
  // otherwise smallest overflow. 32-bit, HiDPI, then refresh rate break ties.
  func score(_ mode: CGDisplayMode) -> (Int, Int, Int, Int, Double) {
    let fits = mode.width <= width && mode.height <= height
    let area = mode.width * mode.height
    let hidpi = mode.pixelWidth != mode.width ? 0 : 1
    return (
      fits ? 0 : 1, fits ? -area : area, is32Bit(mode) ? 0 : 1, hidpi,
      -mode.refreshRate
    )
  }

  let ranked = usable.sorted { score($0) < score($1) }
  let best = ranked[0]

  if let current = CGDisplayCopyDisplayMode(display),
    current.width == best.width && current.height == best.height
      && current.pixelWidth == best.pixelWidth
  {
    print("unchanged \(describe(best))")
    exit(0)
  }

  // Some variants are still rejected by the display (and .permanently can be
  // refused from an SSH session where .forSession is accepted); walk the
  // ranking and scopes until one applies.
  for mode in ranked {
    for option in [CGConfigureOption.permanently, .forSession] {
      var config: CGDisplayConfigRef?
      guard CGBeginDisplayConfiguration(&config) == .success else { continue }
      guard CGConfigureDisplayWithDisplayMode(config, display, mode, nil)
        == .success
      else {
        CGCancelDisplayConfiguration(config)
        continue
      }
      if CGCompleteDisplayConfiguration(config, option) == .success {
        print("set \(describe(mode))")
        exit(0)
      }
    }
  }
  FileHandle.standardError.write(Data("error: set mode failed\n".utf8))
  exit(1)
}

FileHandle.standardError.write(
  Data("usage: displaymode list | displaymode set <width> <height>\n".utf8))
exit(64)
