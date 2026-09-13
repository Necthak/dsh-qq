<#
.SYNOPSIS
  Capture a window (or the screen) to a PNG, the way Windows actually requires.

.DESCRIPTION
  Every ad-hoc screenshot ends up rediscovering the same three traps, so they
  are handled here once:

  1. DPI. An unaware process is told every window is 1/scale of its real size,
     so the bitmap is built too small and the capture silently loses the right
     and bottom thirds. `SetProcessDPIAware()` is called before any window API.
  2. Occlusion. `CopyFromScreen` copies whatever is on top; `PrintWindow` asks
     the window to draw itself. PrintWindow is tried first because it works when
     the window is covered, and the screen is used only as a fallback.
  3. Blank results. A window that has never painted (hidden, or a session that
     is not rendering — a disconnected remote desktop) returns a single flat
     colour. That is detected and reported instead of being sent as "the
     screenshot", and the screen is tried before giving up.

  Output is one line of JSON on stdout, so the caller can parse it:
    {"ok":true,"path":"...","width":1299,"height":817,"bytes":186219,"method":"printwindow"}

.PARAMETER Process
  Process name, as a regular expression (e.g. 'weixin'). The largest visible
  window belonging to a matching process is captured.

.PARAMETER Title
  Window title, as a regular expression. Optional; filters the same way.

.PARAMETER Out
  Output PNG path. Defaults to %TEMP%\dsh-capture.png.

.PARAMETER Screen
  Capture the whole primary screen instead of one window.

.PARAMETER MinWidth
  Ignore windows narrower than this (default 200); splash and tray windows are
  never what the caller means.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -Process weixin
  Captures the largest WeChat window.
#>
param(
  [string]$Process = '',
  [string]$Title = '',
  [string]$Out = '',
  [switch]$Screen,
  [int]$MinWidth = 200,
  # auto    - PrintWindow first, except for known GPU-composited processes
  #           (browsers, Electron) and for windows that render nothing
  # screen  - always copy from the screen: REQUIRED for GPU-composited
  #           windows (Chromium/Electron), where PrintWindow returns a
  #           STALE frame that is neither blank nor an error
  [ValidateSet('auto', 'printwindow', 'screen')][string]$Method = 'auto'
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

# BEFORE any window call: an unaware process reads every rect scaled down, and
# the bitmap built from it clips the window.
[void][DshCapture]::SetProcessDPIAware()

if ($Out -eq '') { $Out = Join-Path $env:TEMP 'dsh-capture.png' }

function Get-Candidates {
  $rows = New-Object System.Collections.ArrayList
  $procs = @()
  if ($Process -ne '') { $procs = @(Get-Process | Where-Object { $_.ProcessName -match $Process } | ForEach-Object { $_.Id }) }
  $cb = [DshCapture+EnumProc]{
    param($h, $p)
    $pid2 = [uint32]0
    [void][DshCapture]::GetWindowThreadProcessId($h, [ref]$pid2)
    $owned = if ($procs.Count -gt 0) { $procs -contains [int]$pid2 } else { $true }
    if ($owned -and [DshCapture]::IsWindowVisible($h) -and [DshCapture]::GetParent($h) -eq [IntPtr]::Zero) {
      $sb = New-Object Text.StringBuilder 512
      [void][DshCapture]::GetWindowTextW($h, $sb, 512)
      $name = $sb.ToString()
      if ($Title -eq '' -or $name -match $Title) {
        $r = New-Object DshCapture+RECT
        [void][DshCapture]::GetWindowRect($h, [ref]$r)
        $w = $r.R - $r.L; $hh = $r.B - $r.T
        if ($w -ge $MinWidth -and $hh -ge $MinWidth) {
          [void]$rows.Add([pscustomobject]@{ Handle = $h; Width = $w; Height = $hh; X = $r.L; Y = $r.T; Title = $name })
        }
      }
    }
    return $true
  }
  [void][DshCapture]::EnumWindows($cb, [IntPtr]::Zero)
  return $rows
}

function Test-Composited {
  # GPU-composited windows (Chromium and everything built on it) answer
  # PrintWindow with a STALE frame: not blank, not an error, just the picture
  # from before whatever changed. Nothing in the pixels reveals it, so the only
  # defence is knowing which processes do it and copying from the screen.
  param($Handle)
  $pid2 = [uint32]0
  [void][DshCapture]::GetWindowThreadProcessId($Handle, [ref]$pid2)
  $name = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
  if ($null -eq $name) { return $false }
  return $name -match '^(msedge|chrome|chromium|firefox|brave|opera|vivaldi|electron)$'
}

function Test-Flat {
  param($Bitmap)
  $seen = @{}
  foreach ($i in 0..7) {
    foreach ($j in 0..7) {
      $x = [Math]::Min($Bitmap.Width - 1, [int]($Bitmap.Width * ($i + 0.5) / 8))
      $y = [Math]::Min($Bitmap.Height - 1, [int]($Bitmap.Height * ($j + 0.5) / 8))
      $seen[$Bitmap.GetPixel($x, $y).ToArgb()] = 1
    }
  }
  return ($seen.Count -le 1)
}

function Save-Flat {
  param($Bitmap, $Path)
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  return (Get-Item $Path).Length
}

$result = [ordered]@{ ok = $false; path = ''; width = 0; height = 0; bytes = 0; method = ''; error = '' }

if ($Screen) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  if (Test-Flat $bmp) {
    # The desktop is not being composited (a disconnected remote session looks
    # exactly like this). Reporting it beats sending a grey rectangle.
    $result.error = 'screen capture is a single flat colour: the desktop is not rendering in this session'
  } else {
    $result.ok = $true; $result.method = 'screen'
  }
  $result.width = $bmp.Width; $result.height = $bmp.Height
  if ($result.ok) { $result.bytes = Save-Flat $bmp $Out; $result.path = $Out }
  $bmp.Dispose()
} else {
  $candidates = Get-Candidates | Sort-Object { $_.Width * $_.Height } -Descending
  if ($candidates.Count -eq 0) {
    $result.error = 'no visible window matched'
  } else {
    # Largest first, but take the largest one that can actually DRAW ITSELF.
    # A big window that never painted (a stale frame, a splash left behind) is
    # not what the caller means, and copying the screen where it happens to sit
    # would capture whatever is behind it and label that "the window".
    $usedMethod = ''
    foreach ($candidate in $candidates) {
      if ($Method -eq 'screen' -or ($Method -eq 'auto' -and (Test-Composited $candidate.Handle))) { break }
      $attempt = New-Object System.Drawing.Bitmap $candidate.Width, $candidate.Height
      $g = [System.Drawing.Graphics]::FromImage($attempt)
      $dc = $g.GetHdc()
      [void][DshCapture]::PrintWindow($candidate.Handle, $dc, 2)   # PW_RENDERFULLCONTENT
      $g.ReleaseHdc($dc)
      $g.Dispose()
      if (-not (Test-Flat $attempt)) {
        $result.width = $attempt.Width; $result.height = $attempt.Height
        $result.bytes = Save-Flat $attempt $Out
        $result.path = $Out
        $result.ok = $true
        $result.method = 'printwindow'
        $attempt.Dispose()
        break
      }
      $attempt.Dispose()
    }

    if (-not $result.ok) {
      # Nothing rendered itself. The screen may still show it, but only trust
      # that for the window that is actually in front - otherwise the pixels
      # belong to some other program.
      $target = $candidates[0]
      $bmp = New-Object System.Drawing.Bitmap $target.Width, $target.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($target.X, $target.Y, 0, 0, $bmp.Size)
      $g.Dispose()
      $result.width = $bmp.Width; $result.height = $bmp.Height
      if (Test-Flat $bmp) {
        $result.error = "no matching window has rendered content (never painted, or the session is not rendering)"
      } else {
        $result.ok = $true; $result.method = 'screen-region'
        $result.bytes = Save-Flat $bmp $Out
        $result.path = $Out
      }
      if ($Method -eq 'screen' -and $result.ok -ne $true) { $result.error = 'the screen shows a single flat colour here' }
      $bmp.Dispose()
    }
  }
}

Write-Output ($result | ConvertTo-Json -Compress)
if ($result.ok) { exit 0 } else { exit 1 }
