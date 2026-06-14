# Docker AI Monitor Windows Launcher Script
# Automatically configures and launches the local environment connector.

$connectorFolder = "$HOME\docker-monitor-connector"
if (!(Test-Path $connectorFolder)) {
    New-Item -ItemType Directory -Force -Path $connectorFolder | Out-Null
}
Set-Location $connectorFolder

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  🐳 Docker Monitor Local Environment Setup  " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

# 1. Check Node.js
$nodeInstalled = $false
try {
    $nodeVersion = node -v
    $nodeInstalled = $true
    Write-Host "✅ Node.js Detected: $nodeVersion" -ForegroundColor Green
} catch {
    $nodeInstalled = $false
}

if (!$nodeInstalled) {
    Write-Host "⚠️ Node.js is not installed." -ForegroundColor Yellow
    $confirm = Read-Host "Do you want to install Node.js automatically via Winget? (Y/N)"
    if ($confirm -eq "Y" -or $confirm -eq "y" -or $confirm -eq "") {
        Write-Host "Downloading and installing Node.js..." -ForegroundColor Cyan
        winget install OpenJS.NodeJS -h --accept-source-agreements --accept-package-agreements
        
        # Refresh environment PATH to find Node immediately
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        
        try {
            $nodeVersion = node -v
            Write-Host "✅ Node.js successfully installed: $nodeVersion" -ForegroundColor Green
        } catch {
            Write-Host "❌ Node.js installed, but PATH is not updated. Please restart PowerShell and run the launcher again." -ForegroundColor Red
            Exit
        }
    } else {
        Write-Host "❌ Node.js is required to run the local connector. Setup cancelled." -ForegroundColor Red
        Exit
    }
}

# 2. Check Docker
$dockerRunning = $false
try {
    $dockerVersion = docker -v
    $dockerInfo = docker info --format '{{json .}}'
    $dockerRunning = $true
    Write-Host "✅ Docker Engine is running." -ForegroundColor Green
} catch {
    $dockerRunning = $false
    Write-Host "⚠️ Docker is not running or not installed." -ForegroundColor Yellow
    Write-Host "-> Please ensure Docker Desktop is running on your machine." -ForegroundColor Yellow
}

# 3. Check Ollama
$ollamaRunning = $false
try {
    $ollamaVersion = ollama -v
    $ollamaRunning = $true
    Write-Host "✅ Ollama CLI is installed." -ForegroundColor Green
} catch {
    $ollamaRunning = $false
    Write-Host "⚠️ Ollama is not installed." -ForegroundColor Yellow
    Write-Host "-> Please install Ollama from https://ollama.com and run: ollama run llama3" -ForegroundColor Yellow
}

# 4. Download connector files
Write-Host "`nDownloading latest connector files from hosted server..." -ForegroundColor Cyan
$baseUrl = "https://docker-nl-ics.onrender.com"
try {
    Invoke-WebRequest -Uri "$baseUrl/local-connector.js" -OutFile "local-connector.js" -UseBasicParsing -TimeoutSec 15
    Invoke-WebRequest -Uri "$baseUrl/package.json" -OutFile "package.json" -UseBasicParsing -TimeoutSec 15
    Write-Host "✅ Downloaded local-connector.js and package.json successfully." -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to download connector files. Hosted web server might be sleeping, attempting retry..." -ForegroundColor Red
    Start-Sleep -Seconds 3
    Invoke-WebRequest -Uri "$baseUrl/local-connector.js" -OutFile "local-connector.js" -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/package.json" -OutFile "package.json" -UseBasicParsing
}

# 5. Install Node packages
Write-Host "Installing lightweight Node dependencies..." -ForegroundColor Cyan
npm install --no-audit --no-fund --quiet

# 6. Launch local connector
Write-Host "`n🚀 Launching Local Connector..." -ForegroundColor Green
node local-connector.js
