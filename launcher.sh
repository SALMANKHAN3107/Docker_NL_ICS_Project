#!/bin/bash
# Docker AI Monitor Mac/Linux Launcher Script
# Automatically configures and launches the local environment connector.

connectorFolder="$HOME/docker-monitor-connector"
mkdir -p "$connectorFolder"
cd "$connectorFolder"

echo "================================================="
echo "  🐳 Docker Monitor Local Environment Setup  "
echo "================================================="

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "⚠️ Node.js is not installed."
    read -p "Do you want to install Node.js automatically? (Y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ || "$confirm" == "" ]]; then
        echo "Installing Node.js..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # Mac
            if ! command -v brew &> /dev/null; then
                echo "Installing Homebrew first..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            fi
            brew install node
        else
            # Linux
            sudo apt-get update && sudo apt-get install -y nodejs npm
        fi
    else
        echo "❌ Node.js is required. Setup cancelled."
        exit 1
    fi
else
    echo "✅ Node.js Detected: $(node -v)"
fi

# 2. Check Docker
if ! command -v docker &> /dev/null || ! docker info &> /dev/null; then
    echo "⚠️ Docker is not running or not installed."
    echo "-> Please ensure Docker Desktop is running on your machine."
else
    echo "✅ Docker Engine is running."
fi

# 3. Check Ollama
if ! command -v ollama &> /dev/null; then
    echo "⚠️ Ollama is not installed."
    echo "-> Please download Ollama and run: ollama run llama3"
else
    echo "✅ Ollama CLI is installed."
fi

# 4. Download connector files
echo -e "\nDownloading latest connector files from hosted server..."
baseUrl="https://docker-nl-ics.onrender.com"
curl -fsSL "$baseUrl/local-connector.js" -o local-connector.js
curl -fsSL "$baseUrl/package.json" -o package.json
echo "✅ Downloaded local-connector.js and package.json successfully."

# 5. Install Node packages
echo "Installing lightweight Node dependencies..."
npm install --no-audit --no-fund --quiet

# 6. Launch local connector
echo -e "\n🚀 Launching Local Connector..."
node local-connector.js
