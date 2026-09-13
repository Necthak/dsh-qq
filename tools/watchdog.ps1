# DeepSeek Harness watchdog.
#
# The bridge has twice gone silent overnight with no trace at all: no error in
# the log, no Windows crash record, no sleep, no reboot, nothing. The cause is
# still unknown, and a process that is killed outright cannot report anything -
# no JavaScript handler runs. So this script stops trying to explain the death
# and starts bounding it: if the server is gone, bring it back.
#
# It doubles as a death clock. A restart line is written with a wall-clock time,
# which is the one fact we never had: knowing that the server died at, say,
# 03:41 is what makes it possible to line the death up against other events.
#
# Design notes, each one paid for:
#   * Runs with NO window. A visible console is a window somebody closes, and
#     closing a console kills everything attached to it.
#   * Single instance through a PID file, NOT through a process-name filter: a
#     name filter matches the checking command's own command line, which has
#     already produced a false "still running" reading once.
#   * Never acts while a restart is in flight. `/restart` deliberately takes the
#     server down for a few seconds, and a watchdog that "fixed" that would
#     start a second server, or fight the first.
#   * ASCII only. Windows PowerShell reads .ps1 files as ANSI unless they carry
#     a BOM, so non-ASCII characters here have silently broken the syntax.
#
# Keep in step with: Start-DeepSeek-Harness.cmd, Stop-DeepSeek-Harness.cmd.

param(
  [int]$Port = 3080,
  [int]$IntervalSeconds = 60,
  # Do one pass and exit, for tests.
  [switch]$Once,
  # Report what would happen without starting anything, for tests.
  [switch]$DryRun,
  # Named DshHome, not Home: PowerShell's $HOME is read-only.
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [string]$Launcher = "$env:USERPROFILE\Documents\Start-DeepSeek-Harness.cmd"
)

$ErrorActionPreference = 'Continue'
$pidFile = Join-Path $DshHome 'dsh-qq-watchdog.pid'
$logFile = Join-Path $DshHome 'dsh-qq-watchdog.log'
$lockFile = Join-Path $DshHome 'web-launch.lock'
$markerFile = Join-Path $DshHome 'dsh-qq-restart.json'
$restarterLog = Join-Path $DshHome 'dsh-qq-restart.log'

function Write-Note([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

function Get-LogTail([int]$Count) {
  # The last lines the server wrote before it went away: the one piece of
  # context that was missing every previous time this happened.
  $bridge = Join-Path $DshHome 'web-launch.log'
  if (-not (Test-Path $bridge)) { return @('(no bridge log)') }
  try {
    return @(Get-Content $bridge -Tail $Count -ErrorAction Stop | ForEach-Object { '    | ' + $_ })
  } catch {
    return @('(bridge log unreadable: ' + $_.Exception.Message + ')')
  }
}

function Get-ServerProcesses {
  # Is the old process still there (a hang) or gone entirely (a kill)? The two
  # point in completely different directions.
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like '*bin.js*' })
  } catch {
    return @()
  }
}

function Test-Port {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $Port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# Is a restart in progress? Three independent signals, because the cost of a
# wrong "no" is a second server fighting the first.
function Test-RestartInFlight {
  $now = Get-Date
  foreach ($path in @($lockFile, $markerFile, $restarterLog)) {
    if (Test-Path $path) {
      $age = ($now - (Get-Item $path).LastWriteTime).TotalSeconds
      # A restart takes about 15 seconds; the launcher's lock lives 3 minutes.
      if ($age -lt 180) { return $true }
    }
  }
  return $false
}

function Get-OwnPid {
  if (-not (Test-Path $pidFile)) { return 0 }
  $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $value = 0
  if ([int]::TryParse($raw, [ref]$value)) { return $value }
  return 0
}

# One watchdog per machine: a second copy sees a live PID and leaves.
if (-not $Once) {
  $other = Get-OwnPid
  if ($other -gt 0 -and $other -ne $PID) {
    $alive = Get-Process -Id $other -ErrorAction SilentlyContinue
    if ($alive) { exit 0 }
  }
  try { Set-Content -Path $pidFile -Value $PID -Encoding ASCII } catch { }
}

if (-not $Once) { Write-Note "watchdog started (pid $PID, port $Port, every ${IntervalSeconds}s)" }

while ($true) {
  if (Test-Port) {
    # Healthy. Say so only on the way back up, not every minute.
    if ($script:wasDown) {
      $seconds = if ($script:downSince) { [int]((Get-Date) - $script:downSince).TotalSeconds } else { 0 }
      Write-Note "server is answering again on port $Port after about ${seconds}s"
      $script:wasDown = $false
    }
  } elseif (Test-RestartInFlight) {
    # Expected downtime; the restarter owns it.
  } else {
    $script:wasDown = $true
    $script:downSince = Get-Date
    $leftovers = Get-ServerProcesses
    Write-Note ("server is DOWN (no restart in flight); leftover server processes: " + $(if ($leftovers.Count -eq 0) { 'none' } else { ($leftovers | ForEach-Object { $_.ProcessId }) -join ',' }))
    foreach ($line in Get-LogTail 6) { Write-Note $line }
    if ($DryRun) {
      Write-Note "DRY RUN: would start $Launcher"
    } else {
      Write-Note "starting the launcher"
      try {
        Start-Process -FilePath 'cmd.exe' `
          -ArgumentList ('/c "' + $Launcher + '" --no-open') `
          -WindowStyle Hidden
      } catch {
        Write-Note "launcher could not be started: $($_.Exception.Message)"
      }
      # Give the launcher its full start-up window before judging it again.
      # Without this the next pass would fire a second launcher at a server that
      # is still coming up - harmless, because the launcher's own lock catches
      # it, but it fills the log with noise that hides the real event.
      if (-not $Once) { Start-Sleep -Seconds 90 }
    }
  }

  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSeconds
}

if (-not $Once) {
  # Only clear the PID file when it is still ours.
  if ((Get-OwnPid) -eq $PID) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}
