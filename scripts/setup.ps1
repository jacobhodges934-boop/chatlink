# ChatLink Setup — one command, zero confusion
# Usage: .\scripts\setup.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "`n  ChatLink Setup`n" -ForegroundColor Cyan

# 1. Build
Write-Host "[1/3] Building MCP Server..." -ForegroundColor Yellow
Push-Location "$repoRoot\mcp-server"
npm install 2>&1 | Out-Null
npm run build 2>&1 | Out-Null
Pop-Location
$serverPath = "$repoRoot\mcp-server\dist\index.js"

# 2. Register Claude Code (stdio — simple, no daemon needed)
Write-Host "[2/3] Registering Claude Code..." -ForegroundColor Yellow
try {
    claude mcp remove chatlink 2>$null | Out-Null
    claude mcp add chatlink -- node "$serverPath" 2>&1 | Out-Null
    Write-Host "  OK   Claude Code (stdio)" -ForegroundColor Green
} catch { Write-Host "  SKIP Claude Code not found" -ForegroundColor Yellow }

# 3. Register OpenCode (needs daemon running first)
Write-Host "[3/3] Registering OpenCode..." -ForegroundColor Yellow
try {
    $token = & node $serverPath --token 2>$null
    opencode mcp remove chatlink 2>$null | Out-Null
    opencode mcp add chatlink --url http://127.0.0.1:27183/mcp --header "Authorization=Bearer $token" 2>&1 | Out-Null
    Write-Host "  OK   OpenCode (needs daemon)" -ForegroundColor Green
} catch { Write-Host "  SKIP OpenCode not found" -ForegroundColor Yellow }

# 4. Open extension pages
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
foreach ($b in @($chrome, $edge)) {
    if (Test-Path $b) {
        $name = if ($b -like "*chrome*") { "chrome://extensions" } else { "edge://extensions" }
        Start-Process $b $name
    }
}

Write-Host "`n  Done. Now:" -ForegroundColor Green
Write-Host "  1. Enable Developer Mode → Load unpacked → select:" -ForegroundColor White
Write-Host "     $repoRoot\chrome-extension" -ForegroundColor Cyan
Write-Host "  2. Restart Claude Code. It just works." -ForegroundColor White
Write-Host ""
Write-Host "  To also use OpenCode: start daemon first" -ForegroundColor Yellow
Write-Host "    .\scripts\daemon.ps1" -ForegroundColor Cyan
Write-Host ""
