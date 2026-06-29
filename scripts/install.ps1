#!/usr/bin/env pwsh
# ChatLink one-click installer for Windows
# Usage: .\scripts\install.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "`n  ChatLink Installer" -ForegroundColor Cyan
Write-Host "  ===================`n" -ForegroundColor Cyan

# ── 1. Check Node.js ──
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node -v 2>$null
    Write-Host "  OK  Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  FAIL  Node.js not found. Install from https://nodejs.org (version 18+)" -ForegroundColor Red
    exit 1
}

# ── 2. Check Claude Code ──
Write-Host "[2/5] Checking Claude Code..." -ForegroundColor Yellow
$claudePath = (Get-Command claude -ErrorAction SilentlyContinue)?.Source
if ($claudePath) {
    Write-Host "  OK  Claude Code found at $claudePath" -ForegroundColor Green
} else {
    Write-Host "  WARN Claude Code CLI not found in PATH. Install: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
}

# ── 3. Install dependencies & build ──
Write-Host "[3/5] Installing dependencies & building..." -ForegroundColor Yellow
Push-Location "$repoRoot\mcp-server"
npm install 2>&1 | Out-Null
npm run build 2>&1 | Out-Null
Pop-Location
Write-Host "  OK  MCP Server built" -ForegroundColor Green

# ── 4. Register Claude Code MCP ──
Write-Host "[4/5] Registering with Claude Code..." -ForegroundColor Yellow
$serverPath = "$repoRoot\mcp-server\dist\index.js"
try {
    # Check if already registered
    $existing = claude mcp list 2>$null | Select-String "chatlink"
    if ($existing) {
        Write-Host "  INFO ChatLink already registered. Skipping." -ForegroundColor Yellow
    } else {
        claude mcp add chatlink -- node "$serverPath" 2>&1 | Out-Null
        Write-Host "  OK  Registered: claude mcp add chatlink" -ForegroundColor Green
    }
} catch {
    Write-Host "  WARN Could not register automatically. Run manually:" -ForegroundColor Yellow
    Write-Host "  claude mcp add chatlink -- node `"$serverPath`"" -ForegroundColor White
}

# ── 5. Open extension pages ──
Write-Host "[5/5] Opening extension settings..." -ForegroundColor Yellow

# Detect installed browsers
$chromePath = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not $edgePath) { $edgePath = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }

if (Test-Path $chromePath) {
    Write-Host "  Chrome detected" -ForegroundColor Green
    Start-Process $chromePath "chrome://extensions"
}
if (Test-Path $edgePath) {
    Write-Host "  Edge detected" -ForegroundColor Green
    Start-Process $edgePath "edge://extensions"
}

Write-Host "`n  Done!" -ForegroundColor Green
Write-Host "  1. Enable Developer Mode in the extensions page" -ForegroundColor White
Write-Host "  2. Click 'Load unpacked' and select:" -ForegroundColor White
Write-Host "     $repoRoot\chrome-extension" -ForegroundColor Cyan
Write-Host "  3. Open any AI chat tab (ChatGPT/Gemini/etc.)" -ForegroundColor White
Write-Host "  4. Restart Claude Code and run: 用 ChatLink 检查扩展状态" -ForegroundColor White
Write-Host ""
