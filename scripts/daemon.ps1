# Start ChatLink daemon silently in background
# Usage: .\scripts\daemon.ps1 [start|stop]

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverPath = "$repoRoot\mcp-server\dist\index.js"

switch ($args[0]) {
  "stop" {
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*chatlink*--http*" } |
      Stop-Process -Force
    Write-Host "ChatLink daemon stopped"
  }
  default {
    # Already running?
    $existing = Get-Process -Name "node" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*chatlink*--http*" }
    if ($existing) {
      Write-Host "ChatLink daemon already running (PID $($existing.Id))"
      exit 0
    }
    # Start hidden
    Start-Process node -ArgumentList "`"$serverPath`" --http" -WindowStyle Hidden
    Start-Sleep 1
    Write-Host "ChatLink daemon started (run '.\scripts\daemon.ps1 stop' to stop)"
  }
}
