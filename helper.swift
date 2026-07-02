import Foundation
import Cocoa

// Track states
var isCtrlPressed = false
var isSpacePressed = false
var isTriggered = false

func checkState() {
    if isCtrlPressed && isSpacePressed {
        if !isTriggered {
            isTriggered = true
            print("keydown")
            fflush(stdout)
        }
    } else {
        if isTriggered {
            isTriggered = false
            print("keyup")
            fflush(stdout)
        }
    }
}

func myEventTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .flagsChanged {
        let flags = event.flags
        let ctrlNow = flags.contains(.maskControl)
        if ctrlNow != isCtrlPressed {
            isCtrlPressed = ctrlNow
            checkState()
        }
    }
    
    if type == .keyDown {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if keyCode == 49 { // 49 is Space
            isSpacePressed = true
            checkState()
        }
    }
    
    if type == .keyUp {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if keyCode == 49 { // 49 is Space
            isSpacePressed = false
            checkState()
        }
    }
    
    return Unmanaged.passRetained(event)
}

let eventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)

guard let eventTap = CGEvent.tapCreate(
    tap: .cCGSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(eventMask),
    callback: myEventTapCallback,
    refcon: nil
) else {
    fputs("Error: failed to create event tap. Make sure the application has Accessibility permissions.\n", stderr)
    fflush(stderr)
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)

print("Swift keyboard listener active.")
fflush(stdout)

CFRunLoopRun()
