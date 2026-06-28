# ChatLink MCP restart script — build + kill old process + wait for port release
$ErrorActionPreference = "Stop"
Set-Location (Split-Path (Split-Path $PSScriptRoot))

Write-Host "[1/4] npm run build..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

Write-Host "[2/4] Checking for existing ChatLink process..."
$ownerFile = "$env:TEMP\chatmcp-27182.owner.json"
if (Test-Path $ownerFile) {
    try {
        $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
        $pid = $owner.pid
        if ($pid) {
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq "node") {
                Write-Host "  Killing old ChatLink (PID $pid)..."
                Stop-Process -Id $pid -Force
                Write-Host "  Killed."
            }
        }
    } catch {
        Write-Host "  No valid owner file, skipping kill."
    }
} else {
    Write-Host "  No owner file, skipping kill."
}

Write-Host "[3/4] Waiting for port 27182 to release..."
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
    $inUse = Get-NetTCPConnection -LocalPort 27182 -State Listen -ErrorAction SilentlyContinue
    if (-not $inUse) { Write-Host "  Port free."; break }
    Start-Sleep -Milliseconds 200
}

Write-Host "[4/4] Ready. Now run: /reload-plugins --force"
