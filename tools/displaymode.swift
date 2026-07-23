// displaymode — list or set the main display's resolution.
//
//   displaymode list
//   displaymode set <width> <height>
//
// `set` picks the largest usable mode that fits within the requested size
// (so the remote desktop never overflows the browser viewport); if nothing
// fits it picks the smallest mode overall. Applied permanently.
//
// Build on the target Mac (needs Command Line Tools):
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

  // Rank: modes that fit within the target come first (largest area wins);
  // otherwise smallest overflow. HiDPI then refresh rate break ties.
  func score(_ mode: CGDisplayMode) -> (Int, Int, Int, Double) {
    let fits = mode.width <= width && mode.height <= height
    let area = mode.width * mode.height
    let hidpi = mode.pixelWidth != mode.width ? 0 : 1
    return (fits ? 0 : 1, fits ? -area : area, hidpi, -mode.refreshRate)
  }

  let best = usable.min { score($0) < score($1) }!

  if let current = CGDisplayCopyDisplayMode(display),
    current.width == best.width && current.height == best.height
      && current.pixelWidth == best.pixelWidth
  {
    print("unchanged \(describe(best))")
    exit(0)
  }

  var config: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&config) == .success,
    CGConfigureDisplayWithDisplayMode(config, display, best, nil) == .success,
    CGCompleteDisplayConfiguration(config, .permanently) == .success
  else {
    FileHandle.standardError.write(Data("error: set mode failed\n".utf8))
    exit(1)
  }
  print("set \(describe(best))")
  exit(0)
}

FileHandle.standardError.write(
  Data("usage: displaymode list | displaymode set <width> <height>\n".utf8))
exit(64)
