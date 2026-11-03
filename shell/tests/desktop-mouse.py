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
    parser.add_argument("--from", dest="start", type=float, nargs=2)
    parser.add_argument("--to", dest="end", type=float, nargs=2)
    parser.add_argument("--scale", type=float)
    parser.add_argument("--hold-ms", type=int, default=150)
    parser.add_argument("--prepare-only", action="store_true")
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
    if options.prepare_only:
        # The default logical size can exceed the physical work area at high DPI.
        # Fit this fixture before the caller measures DOM gesture coordinates.
        work = wintypes.RECT()
        bounds = wintypes.RECT()
        if not user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0):
            raise ctypes.WinError(ctypes.get_last_error())
        if not user32.GetWindowRect(hwnd, ctypes.byref(bounds)):
            raise ctypes.WinError(ctypes.get_last_error())
        width = min(bounds.right - bounds.left, work.right - work.left)
        height = min(bounds.bottom - bounds.top, work.bottom - work.top)
        left = max(work.left, min(bounds.left, work.right - width))
        top = max(work.top, min(bounds.top, work.bottom - height))
        if not user32.MoveWindow(hwnd, left, top, width, height, True):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    if options.start is None or options.end is None or options.scale is None:
        parser.error("gestures require --from, --to and --scale")
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
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            user32.AttachThreadInput(current_thread, foreground_thread, False)
        time.sleep(0.1)
        if user32.GetForegroundWindow() != hwnd:
            raise RuntimeError("Could not focus the isolated fixture window")
        move(*options.start)
        button(0x0002)  # MOUSEEVENTF_LEFTDOWN
        try:
            time.sleep(0.08)
            for step in range(1, 25):
                fraction = step / 24
                move(*(start + (end - start) * fraction for start, end in zip(options.start, options.end)))
                time.sleep(0.025)
            time.sleep(options.hold_ms / 1000)
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
