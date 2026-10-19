// Real macOS pointer input for the UI-S01 shell suite: the window drag and
// the clicks have to go through the window server (a CDP click never meets
// the app's drag regions). Needs the Accessibility permission of the
// terminal that runs the suite.
//
//   os-input click X Y
//   os-input drag X1 Y1 X2 Y2
//
// Coordinates are global display points (origin at the top-left of the main
// display), the same space as Electron's window bounds.
import CoreGraphics
import Foundation

func post(_ type: CGEventType, _ point: CGPoint) {
  guard
    let event = CGEvent(
      mouseEventSource: nil, mouseType: type, mouseCursorPosition: point,
      mouseButton: .left)
  else {
    FileHandle.standardError.write("cannot create event\n".data(using: .utf8)!)
    exit(2)
  }
  event.post(tap: .cghidEventTap)
}

func pause(_ ms: UInt32) { usleep(ms * 1000) }

let args = CommandLine.arguments.dropFirst().map { Double($0) ?? .nan }
let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

guard CGPreflightPostEventAccess() else {
  FileHandle.standardError.write("no permission to post events\n".data(using: .utf8)!)
  exit(3)
}

switch command {
case "click" where args.count == 3:
  let point = CGPoint(x: args[1], y: args[2])
  post(.mouseMoved, point)
  pause(60)
  post(.leftMouseDown, point)
  pause(50)
  post(.leftMouseUp, point)
  pause(60)
case "drag" where args.count == 5:
  let from = CGPoint(x: args[1], y: args[2])
  let to = CGPoint(x: args[3], y: args[4])
  post(.mouseMoved, from)
  pause(80)
  post(.leftMouseDown, from)
  pause(120)
  let steps = 12
  for step in 1...steps {
    let t = Double(step) / Double(steps)
    post(
      .leftMouseDragged,
      CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
    pause(25)
  }
  pause(120)
  post(.leftMouseUp, to)
  pause(150)
default:
  FileHandle.standardError.write("usage: os-input click X Y | drag X1 Y1 X2 Y2\n".data(using: .utf8)!)
  exit(64)
}
