"""Send an OS mouse gesture to one isolated desktop fixture's client area."""
import argparse
import ctypes
from ctypes import wintypes
import time


class MouseInput(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class InputData(ctypes.Union):
    _fields_ = [("mi", MouseInput)]


class Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("data", InputData)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--from", dest="start", required=True, type=float, nargs=2)
    parser.add_argument("--to", dest="end", required=True, type=float, nargs=2)
    parser.add_argument("--scale", required=True, type=float)
    parser.add_argument("--source-window", type=int)
    parser.add_argument("--hold-at-target", type=float, default=0.15)
    options = parser.parse_args()
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int]
    user32.WindowFromPoint.argtypes = [wintypes.POINT]
    user32.WindowFromPoint.restype = wintypes.HWND
    user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetAncestor.restype = wintypes.HWND
    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    windows = []

    @callback
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, len(title))
        if pid.value == options.pid and user32.IsWindowVisible(hwnd) and title.value == "SealShell":
            windows.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    if len(windows) != 1:
        raise RuntimeError(f"Expected one visible fixture window for {options.pid}, got {windows}")
    hwnd = windows[0]
    origin = wintypes.POINT()
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        raise ctypes.WinError(ctypes.get_last_error())
    previous = user32.GetForegroundWindow()
    cursor = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(cursor))

    def move(x, y):
        if not user32.SetCursorPos(round(origin.x + x * options.scale), round(origin.y + y * options.scale)):
            raise ctypes.WinError(ctypes.get_last_error())

    def button(flags):
        event = Input(type=0, data=InputData(mi=MouseInput(dwFlags=flags)))
        if user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
            raise ctypes.WinError(ctypes.get_last_error())

    try:
        current_thread = ctypes.windll.kernel32.GetCurrentThreadId()
        foreground_thread = user32.GetWindowThreadProcessId(previous, None)
        message = wintypes.MSG()
        user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        user32.AttachThreadInput(current_thread, foreground_thread, True)
        try:
            focus = options.source_window or hwnd
            if options.source_window:
                user32.BringWindowToTop(hwnd)
                user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(focus)
            user32.SetForegroundWindow(focus)
        finally:
            user32.AttachThreadInput(current_thread, foreground_thread, False)
        time.sleep(0.1)
        if user32.GetForegroundWindow() != focus:
            raise RuntimeError("Could not focus the isolated fixture window")
        start = options.start
        if options.source_window:
            start = [(start[0] - origin.x) / options.scale, (start[1] - origin.y) / options.scale]
        move(*start)
        if options.source_window:
            point = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(point))
            actual = user32.GetAncestor(user32.WindowFromPoint(point), 2)
            if actual != options.source_window:
                raise RuntimeError("File source is obscured by another window")
        button(0x0002)  # MOUSEEVENTF_LEFTDOWN
        try:
            time.sleep(0.08)
            if options.source_window:
                move(start[0] + 12 / options.scale, start[1])
                time.sleep(0.2)
            for step in range(1, 25):
                fraction = step / 24
                move(*(first + (end - first) * fraction for first, end in zip(start, options.end)))
                time.sleep(0.025)
            time.sleep(options.hold_at_target)
            if options.source_window:
                point = wintypes.POINT()
                user32.GetCursorPos(ctypes.byref(point))
                actual = user32.GetAncestor(user32.WindowFromPoint(point), 2)
                if actual != hwnd:
                    raise RuntimeError("Drop target is obscured by another window")
        finally:
            button(0x0004)  # MOUSEEVENTF_LEFTUP
            # SendInput queues the release. Let the OLE loop consume it before
            # restoring the cursor/focus, or the drop can land outside the app.
            time.sleep(0.15)
    finally:
        user32.SetCursorPos(cursor.x, cursor.y)
        if previous:
            user32.SetForegroundWindow(previous)


if __name__ == "__main__":
    main()
