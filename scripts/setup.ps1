# ChatLink Setup — one command for everything
# Usage: .\scripts\setup.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "`n  ChatLink Setup`n" -ForegroundColor Cyan

# 1. Build
Write-Host "[1/4] Building MCP Server..." -ForegroundColor Yellow
Push-Location "$repoRoot\mcp-server"
npm install 2>&1 | Out-Null
npm run build 2>&1 | Out-Null
Pop-Location

# 2. Get token
Write-Host "[2/4] Configuring..." -ForegroundColor Yellow
$serverPath = "$repoRoot\mcp-server\dist\index.js"
$token = & node $serverPath --token 2>$null
if (-not $token) { Write-Host "  FAIL  Build may have failed"; exit 1 }
Write-Host "  OK   Token ready" -ForegroundColor Green

# 3. Register Claude Code
Write-Host "[3/4] Registering Claude Code..." -ForegroundColor Yellow
try {
    claude mcp remove chatlink 2>$null | Out-Null
    claude mcp add --transport http chatlink http://127.0.0.1:27183/mcp --header "Authorization: Bearer $token" 2>&1 | Out-Null
    Write-Host "  OK   Claude Code" -ForegroundColor Green
} catch { Write-Host "  SKIP Claude Code not found" -ForegroundColor Yellow }

# 4. Register OpenCode
Write-Host "[4/4] Registering OpenCode..." -ForegroundColor Yellow
try {
    opencode mcp remove chatlink 2>$null | Out-Null
    opencode mcp add chatlink --url http://127.0.0.1:27183/mcp --header "Authorization=Bearer $token" 2>&1 | Out-Null
    Write-Host "  OK   OpenCode" -ForegroundColor Green
} catch { Write-Host "  SKIP OpenCode not found" -ForegroundColor Yellow }

# 5. Open extension page
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"

foreach ($b in @($chrome, $edge)) {
    if (Test-Path $b) {
        $name = if ($b -like "*chrome*") { "chrome://extensions" } else { "edge://extensions" }
        Start-Process $b $name
    }
}

Write-Host "`n  1. Enable Developer Mode → Load unpacked → select:" -ForegroundColor White
Write-Host "     $repoRoot\chrome-extension" -ForegroundColor Cyan
Write-Host "  2. Start the daemon:" -ForegroundColor White
Write-Host "     node `"$serverPath`" --http" -ForegroundColor Cyan
Write-Host "  3. Restart Claude Code / OpenCode" -ForegroundColor White
Write-Host ""
