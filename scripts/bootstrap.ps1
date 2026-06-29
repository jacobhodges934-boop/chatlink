# ChatLink remote bootstrap — one-liner installer (Windows)
# Usage: irm https://raw.githubusercontent.com/jacobhodges934-boop/chatlink/master/scripts/bootstrap.ps1 | iex
# Or:    irm ... | iex; Install-ChatLink -Client opencode
param([string]$Client = "claude")

$ErrorActionPreference = "Stop"
$repo = "https://github.com/jacobhodges934-boop/chatlink.git"
$dir = "$env:USERPROFILE\chatlink"

Write-Host "`n  ChatLink Bootstrap  →  $Client" -ForegroundColor Cyan
Write-Host "  ================================`n" -ForegroundColor Cyan

if (Test-Path "$dir\.git") {
    Write-Host "Updating existing repo..." -ForegroundColor Yellow
    Push-Location $dir; git pull --ff-only; Pop-Location
} else {
    Write-Host "Cloning ChatLink..." -ForegroundColor Yellow
    git clone $repo $dir
}

Write-Host "Building MCP Server..." -ForegroundColor Yellow
Push-Location "$dir\mcp-server"
npm install 2>&1 | Out-Null
npm run build 2>&1 | Out-Null
Pop-Location

Write-Host "Configuring for $Client..." -ForegroundColor Yellow
& "$dir\scripts\install.ps1" -Client $Client

Write-Host "`n  All done. Load the extension and restart $Client." -ForegroundColor Green
Write-Host "  Then run: 使用 ChatLink 检查扩展状态`n" -ForegroundColor White
