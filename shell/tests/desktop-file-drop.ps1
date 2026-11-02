param([string]$PathsJson, [int]$TargetPid)
$ErrorActionPreference = 'Stop'
$paths = [string[]](ConvertFrom-Json $PathsJson)
$directory = [IO.Path]::GetDirectoryName($paths[0])
$shell = New-Object -ComObject Shell.Application
$before = @($shell.Windows() | ForEach-Object { $_.HWND })
$window = $null
try {
    Start-Process explorer.exe -ArgumentList ('/n,/separate,"' + $directory + '"') -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        $window = $shell.Windows() | Where-Object {
            $_.HWND -notin $before -and $_.Document.Folder.Self.Path -eq $directory
        } | Select-Object -First 1
        if ($window) { break }
        Start-Sleep -Milliseconds 100
    }
    if (!$window) { throw 'Fixture Explorer window not found' }
    $window.Visible = $true
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindows {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint parameter, out Rect rect, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
'@
    $null = [FixtureWindows]::SetProcessDpiAwarenessContext([IntPtr](-4))
    $target = Get-Process -Id $TargetPid
    if ($target.MainWindowTitle -ne 'SealShell') { throw 'Target is not the fixture application' }
    $rect = New-Object FixtureWindows+Rect
    $null = [FixtureWindows]::GetWindowRect($target.MainWindowHandle, [ref]$rect)
    # Native gestures cannot reach client pixels under the taskbar, even though
    # CDP screenshots and DOM bounds include that portion of a cascaded window.
    $work = New-Object FixtureWindows+Rect
    $null = [FixtureWindows]::SystemParametersInfo(48, 0, [ref]$work, 0)
    $x = [Math]::Max($work.Left, [Math]::Min($rect.Left, $work.Right - ($rect.Right - $rect.Left)))
    $y = [Math]::Max($work.Top, [Math]::Min($rect.Top, $work.Bottom - ($rect.Bottom - $rect.Top)))
    $null = [FixtureWindows]::SetWindowPos($target.MainWindowHandle, [IntPtr]::Zero, $x, $y, 0, 0, 21)
    $null = [FixtureWindows]::GetWindowRect($target.MainWindowHandle, [ref]$rect)
    $null = [FixtureWindows]::SetWindowPos([IntPtr]$window.HWND, [IntPtr]::Zero, $rect.Right - 650, $rect.Top + 40, 650, 480, 20)
    Start-Sleep -Milliseconds 300
    for ($i = 0; $i -lt $paths.Count; $i++) {
        if ([IO.Path]::GetDirectoryName($paths[$i]) -ne $directory) { throw 'Fixture paths must share one directory' }
        $item = $window.Document.Folder.ParseName([IO.Path]::GetFileName($paths[$i]))
        $window.Document.SelectItem($item, $(if ($i -eq 0) { 29 } else { 1 }))
    }
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.HWND)
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $selected = $null
    while (!$selected -and [DateTime]::UtcNow -lt $deadline) {
        foreach ($item in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
            $pattern = $null
            if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) -and
                $pattern.Current.IsSelected -and $item.Current.BoundingRectangle.Width -gt 0 -and
                $item.Current.Name -in @($paths | ForEach-Object { [IO.Path]::GetFileName($_); [IO.Path]::GetFileNameWithoutExtension($_) })) { $selected = $item; break }
        }
        if (!$selected) { Start-Sleep -Milliseconds 100 }
    }
    if (!$selected) { throw 'Selected fixture file not found in Explorer' }
    $bounds = $selected.Current.BoundingRectangle
    @{ window = [long]$window.HWND; x = $bounds.X + [Math]::Min(80, $bounds.Width / 2); y = $bounds.Y + $bounds.Height / 2 } | ConvertTo-Json -Compress
    # The caller drives a real mouse gesture, then releases this owned window.
    $null = [Console]::ReadLine()
} finally {
    if ($window -and $window.Document.Folder.Self.Path -eq $directory) { $window.Quit() }
}
