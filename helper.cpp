#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

bool isCtrlPressed = false;
bool isSpacePressed = false;
bool isTriggered = false;
bool needsKeyDownEmit = false;
bool needsKeyUpEmit = false;
bool needsCtrlDownDebug = false;
bool needsCtrlUpDebug = false;
bool needsSpaceDownDebug = false;
bool needsSpaceUpDebug = false;
bool needsTapDisabledDebug = false;
CFMachPortRef globalEventTap = NULL;

void postKey(CGKeyCode keyCode, bool keyDown, CGEventFlags flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, keyCode, keyDown);
    CGEventSetFlags(event, flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

int pasteClipboard() {
    postKey(55, true, kCGEventFlagMaskCommand);  // Command down
    usleep(50000);
    postKey(9, true, kCGEventFlagMaskCommand);   // V down
    usleep(50000);
    postKey(9, false, kCGEventFlagMaskCommand);  // V up
    usleep(50000);
    postKey(55, false, 0);                       // Command up
    return 0;
}

void checkState() {
    if (isCtrlPressed && isSpacePressed) {
        if (!isTriggered) {
            isTriggered = true;
            needsKeyDownEmit = true;
        }
    } else {
        if (isTriggered) {
            isTriggered = false;
            needsKeyUpEmit = true;
        }
    }
}

void flushPendingEvents(CFRunLoopTimerRef timer, void *info) {
    if (needsTapDisabledDebug) {
        needsTapDisabledDebug = false;
        printf("debug event tap disabled; re-enabling\n");
        fflush(stdout);
        if (globalEventTap) {
            CGEventTapEnable(globalEventTap, true);
        }
    }

    if (needsCtrlDownDebug) {
        needsCtrlDownDebug = false;
        printf("debug ctrl down\n");
        fflush(stdout);
    }

    if (needsCtrlUpDebug) {
        needsCtrlUpDebug = false;
        printf("debug ctrl up\n");
        fflush(stdout);
    }

    if (needsSpaceDownDebug) {
        needsSpaceDownDebug = false;
        printf("debug space down\n");
        fflush(stdout);
    }

    if (needsSpaceUpDebug) {
        needsSpaceUpDebug = false;
        printf("debug space up\n");
        fflush(stdout);
    }

    if (needsKeyDownEmit) {
        needsKeyDownEmit = false;
        printf("keydown\n");
        fflush(stdout);
    }

    if (needsKeyUpEmit) {
        needsKeyUpEmit = false;
        printf("keyup\n");
        fflush(stdout);
    }
}

CGEventRef myEventTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        needsTapDisabledDebug = true;
        return event;
    }

    if (type == kCGEventFlagsChanged) {
        CGEventFlags flags = CGEventGetFlags(event);
        bool ctrlNow = (flags & kCGEventFlagMaskControl) != 0;
        if (ctrlNow != isCtrlPressed) {
            isCtrlPressed = ctrlNow;
            if (isCtrlPressed) {
                needsCtrlDownDebug = true;
            } else {
                needsCtrlUpDebug = true;
            }
            checkState();
        }
    }
    
    if (type == kCGEventKeyDown) {
        int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        if (keyCode == 49) { // Space keycode
            isSpacePressed = true;
            needsSpaceDownDebug = true;
            checkState();
        }
    }
    
    if (type == kCGEventKeyUp) {
        int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        if (keyCode == 49) { // Space keycode
            isSpacePressed = false;
            needsSpaceUpDebug = true;
            checkState();
        }
    }
    
    return event;
}

int main(int argc, char *argv[]) {
    if (argc > 1 && strcmp(argv[1], "--paste") == 0) {
        return pasteClipboard();
    }

    CGEventMask eventMask = (1LL << kCGEventKeyDown) | (1LL << kCGEventKeyUp) | (1LL << kCGEventFlagsChanged);
    
    CFMachPortRef eventTap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly,
        eventMask,
        myEventTapCallback,
        NULL
    );
    
    if (!eventTap) {
        fprintf(stderr, "Error: failed to create event tap. Make sure the application has Accessibility permissions.\n");
        fflush(stderr);
        exit(1);
    }

    globalEventTap = eventTap;
    
    CFRunLoopSourceRef runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, kCFRunLoopCommonModes);
    CGEventTapEnable(eventTap, true);

    CFRunLoopTimerRef emitTimer = CFRunLoopTimerCreate(
        kCFAllocatorDefault,
        CFAbsoluteTimeGetCurrent(),
        1.0 / 60.0,
        0,
        0,
        flushPendingEvents,
        NULL
    );
    CFRunLoopAddTimer(CFRunLoopGetCurrent(), emitTimer, kCFRunLoopCommonModes);
    
    printf("Native keyboard listener active.\n");
    fflush(stdout);
    
    CFRunLoopRun();
    return 0;
}
