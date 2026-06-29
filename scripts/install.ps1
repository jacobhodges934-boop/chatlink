#!/usr/bin/env pwsh
# ChatLink one-click installer for Windows
# Usage: .\scripts\install.ps1 [-Client claude|opencode|cursor|all]

param([string]$Client = "claude")

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "`n  ChatLink Installer  (client: $Client)" -ForegroundColor Cyan
Write-Host "  ======================================`n" -ForegroundColor Cyan

# ── 1. Check Node.js ──
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node -v 2>$null
    $nodeMajor = [int](node -e "console.log(process.versions.node.split('.')[0])" 2>$null)
    if ($nodeMajor -lt 18) {
        Write-Host "  FAIL  Node.js v$nodeMajor too old. Need v18+. Install from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK   Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  FAIL  Node.js not found. Install from https://nodejs.org (version 18+)" -ForegroundColor Red
    exit 1
}

# ── 2. Check clients ──
Write-Host "[2/5] Checking AI coding agents..." -ForegroundColor Yellow
$hasClaude = (Get-Command claude -ErrorAction SilentlyContinue) -ne $null
$hasOpenCode = (Get-Command opencode -ErrorAction SilentlyContinue) -ne $null
$hasCursor = Test-Path "$env:LOCALAPPDATA\Programs\Cursor\Cursor.exe"

switch ($Client) {
    "claude" {
        if ($hasClaude) { Write-Host "  OK   Claude Code found" -ForegroundColor Green }
        else { Write-Host "  WARN  Claude Code not found. Install: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow }
    }
    "opencode" {
        if ($hasOpenCode) { Write-Host "  OK   OpenCode found" -ForegroundColor Green }
        else { Write-Host "  WARN  OpenCode CLI not found. Install from https://opencode.ai" -ForegroundColor Yellow }
    }
    "cursor" {
        if ($hasCursor) { Write-Host "  OK   Cursor found" -ForegroundColor Green }
        else { Write-Host "  INFO  Cursor.exe not detected. Make sure it is installed." -ForegroundColor Yellow }
    }
    "all" {
        if ($hasClaude) { Write-Host "  OK   Claude Code found" -ForegroundColor Green } else { Write-Host "  WARN  Claude Code not found" -ForegroundColor Yellow }
        if ($hasOpenCode) { Write-Host "  OK   OpenCode found" -ForegroundColor Green } else { Write-Host "  INFO  OpenCode not found (skip)" -ForegroundColor Yellow }
        if ($hasCursor) { Write-Host "  OK   Cursor found" -ForegroundColor Green } else { Write-Host "  INFO  Cursor not found (skip)" -ForegroundColor Yellow }
    }
}

# ── 3. Install dependencies & build ──
Write-Host "[3/5] Installing dependencies & building..." -ForegroundColor Yellow
Push-Location "$repoRoot\mcp-server"
npm install 2>&1 | Out-Null
npm run build 2>&1 | Out-Null
Pop-Location
Write-Host "  OK   MCP Server built" -ForegroundColor Green

# ── 4. Write MCP configs ──
Write-Host "[4/5] Configuring MCP clients..." -ForegroundColor Yellow
$serverPath = "$repoRoot\mcp-server\dist\index.js"

function Merge-McpConfig {
    param($ConfigPath, $McpEntry)
    $dir = Split-Path -Parent $ConfigPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $cfg = @{}
    if (Test-Path $ConfigPath) {
        try {
            $raw = Get-Content $ConfigPath -Raw
            $stripped = $raw -replace '//.*$', '' -replace '/\*[\s\S]*?\*/', ''
            $cfg = $stripped | ConvertFrom-Json -ErrorAction SilentlyContinue
            if (-not $cfg) { $cfg = @{} }
        } catch { $cfg = @{} }
    }
    $mcpServers = @{}
    if ($cfg.mcpServers) { $cfg.mcpServers.PSObject.Properties | ForEach-Object { $mcpServers[$_.Name] = $_.Value } }
    $mcpServers["chatlink"] = $McpEntry
    $cfg | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue $mcpServers -Force
    $cfg | ConvertTo-Json -Depth 5 | Set-Content $ConfigPath -Encoding UTF8
}

function Register-Claude {
    if (-not $hasClaude) { return }
    try {
        if (claude mcp list 2>$null | Select-String "chatlink") {
            Write-Host "  INFO  Claude Code: already registered" -ForegroundColor Yellow
        } else {
            claude mcp add chatlink -- node "$serverPath" 2>&1 | Out-Null
            Write-Host "  OK    Claude Code: registered" -ForegroundColor Green
        }
    } catch {
        Write-Host "  WARN  Claude Code: registration failed — run manually:" -ForegroundColor Yellow
        Write-Host "        claude mcp add chatlink -- node `"$serverPath`"" -ForegroundColor White
    }
}

function Register-OpenCode {
    if (-not $hasOpenCode -and $Client -ne "all") { return }
    $cfg = "$env:USERPROFILE\.config\opencode\opencode.json"
    $entry = @{ type = "local"; command = "node"; args = @($serverPath) }
    Merge-McpConfig $cfg $entry
    Write-Host "  OK    OpenCode: $cfg" -ForegroundColor Green
}

function Register-Cursor {
    if (-not $hasCursor -and $Client -ne "all") { return }
    $cfg = "$env:USERPROFILE\.cursor\mcp.json"
    $entry = @{ command = "node"; args = @($serverPath) }
    Merge-McpConfig $cfg $entry
    Write-Host "  OK    Cursor: $cfg" -ForegroundColor Green
}

switch ($Client) {
    "claude"   { Register-Claude }
    "opencode" { Register-OpenCode }
    "cursor"   { Register-Cursor }
    "all"      { Register-Claude; Register-OpenCode; Register-Cursor }
}

# ── 5. Open extension pages ──
Write-Host "[5/5] Opening extension settings..." -ForegroundColor Yellow

$chromePath = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edgePath)) { $edgePath = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }

if (Test-Path $chromePath) {
    Write-Host "  Chrome detected" -ForegroundColor Green
    Start-Process $chromePath "chrome://extensions"
}
if (Test-Path $edgePath) {
    Write-Host "  Edge detected" -ForegroundColor Green
    Start-Process $edgePath "edge://extensions"
}

$agentName = switch ($Client) { "claude" { "Claude Code" }; "opencode" { "OpenCode" }; "cursor" { "Cursor" }; "all" { "your coding agent" } }
Write-Host "`n  Done!" -ForegroundColor Green
Write-Host "  1. Enable Developer Mode in the extensions page" -ForegroundColor White
Write-Host "  2. Click 'Load unpacked' and select:" -ForegroundColor White
Write-Host "     $repoRoot\chrome-extension" -ForegroundColor Cyan
Write-Host "  3. Open any AI chat tab (ChatGPT/Gemini/etc.)" -ForegroundColor White
Write-Host "  4. Restart $agentName" -ForegroundColor White
Write-Host ""
