# PKRelay Native Messaging Host Installer for Windows
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$HostName = "com.nooma.pkrelay"
$ManifestFile = "$HostName.json"

Write-Host "PKRelay Native Messaging Host Installer (Windows)"
Write-Host ""

# --- Find pkrelay binary ---
$BinaryPath = $null

# Check npm global bin
$npmBin = & npm bin -g 2>$null
if ($npmBin -and (Test-Path "$npmBin\pkrelay.cmd")) {
    $BinaryPath = "$npmBin\pkrelay.cmd"
}

# Check if pkrelay is in PATH
if (-not $BinaryPath) {
    $found = Get-Command pkrelay -ErrorAction SilentlyContinue
    if ($found) {
        $BinaryPath = $found.Source
    }
}

# Check local node_modules
if (-not $BinaryPath -and (Test-Path ".\node_modules\.bin\pkrelay.cmd")) {
    $BinaryPath = (Resolve-Path ".\node_modules\.bin\pkrelay.cmd").Path
}

if (-not $BinaryPath) {
    Write-Host "Error: Could not find 'pkrelay' binary." -ForegroundColor Red
    Write-Host "Install it first: npm install -g @nooma-stack/pkrelay"
    exit 1
}

Write-Host "Found pkrelay binary: $BinaryPath"

# --- Build manifest JSON ---
$ManifestContent = @"
{
  "name": "$HostName",
  "description": "PKRelay MCP Server — AI browser bridge",
  "path": "$($BinaryPath -replace '\\', '\\\\')",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
"@

# --- Detect browsers and write manifests ---
$Configured = @()

$Browsers = @(
    @{ Name = "Chrome"; Dir = "$env:LOCALAPPDATA\Google\Chrome\User Data\NativeMessagingHosts"; RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" },
    @{ Name = "Edge";   Dir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\NativeMessagingHosts";   RegKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" }
)

foreach ($browser in $Browsers) {
    # Check if browser is installed by looking for User Data parent
    $parentDir = Split-Path $browser.Dir
    if (-not (Test-Path $parentDir)) {
        continue
    }

    # Create NativeMessagingHosts directory if needed
    if (-not (Test-Path $browser.Dir)) {
        New-Item -ItemType Directory -Path $browser.Dir -Force | Out-Null
    }

    # Write manifest file
    $manifestPath = Join-Path $browser.Dir $ManifestFile
    $ManifestContent | Out-File -FilePath $manifestPath -Encoding utf8
    Write-Host "  Wrote manifest to $manifestPath"

    # Add registry key (required on Windows)
    $regParent = Split-Path $browser.RegKey
    if (-not (Test-Path $regParent)) {
        New-Item -Path $regParent -Force | Out-Null
    }
    New-Item -Path $browser.RegKey -Force | Out-Null
    Set-ItemProperty -Path $browser.RegKey -Name "(Default)" -Value $manifestPath
    Write-Host "  Added registry key: $($browser.RegKey)"

    $Configured += $browser.Name
}

if ($Configured.Count -eq 0) {
    Write-Host ""
    Write-Host "Error: No supported browsers detected (Chrome, Edge)." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Native messaging host installed for: $($Configured -join ', ')" -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANT: Update the 'allowed_origins' in each manifest with your"
Write-Host "actual extension ID. Find it at chrome://extensions with developer mode on."
Write-Host "  Format: chrome-extension://EXTENSION_ID/"
