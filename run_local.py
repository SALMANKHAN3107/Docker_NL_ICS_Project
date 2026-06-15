import os
import sys
import socket
import subprocess
import urllib.request
import webbrowser
import time

def print_banner(text):
    print("\n" + "=" * 60)
    print(f" {text}")
    print("=" * 60)

def detect_framework():
    print("[1/3] Detecting project framework...")
    if os.path.exists("package.json"):
        print(" -> Detected Framework: Node.js / React (Vite)")
        return "node"
    
    # Check for Python frameworks in current dir files
    streamlit_found = False
    flask_found = False
    fastapi_found = False

    if os.path.exists("requirements.txt"):
        with open("requirements.txt", "r", encoding="utf-8", errors="ignore") as f:
            reqs = f.read().lower()
            if "streamlit" in reqs:
                streamlit_found = True
            if "flask" in reqs:
                flask_found = True
            if "fastapi" in reqs or "uvicorn" in reqs:
                fastapi_found = True

    for root, dirs, files in os.walk("."):
        if "node_modules" in root or "venv" in root or ".git" in root:
            continue
        for file in files:
            if file.endswith(".py"):
                path = os.path.join(root, file)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                        if "import streamlit" in content or "from streamlit" in content:
                            streamlit_found = True
                        if "import flask" in content or "from flask" in content:
                            flask_found = True
                        if "import fastapi" in content or "from fastapi" in content:
                            fastapi_found = True
                except:
                    pass

    if streamlit_found:
        print(" -> Detected Framework: Streamlit")
        return "streamlit"
    elif fastapi_found:
        print(" -> Detected Framework: FastAPI")
        return "fastapi"
    elif flask_found:
        print(" -> Detected Framework: Flask")
        return "flask"
    
    print(" -> Detected Framework: Unknown (Defaulting to general Node)")
    return "node"

def run_startup_checks(framework):
    print_banner("STARTUP VALIDATION")
    
    all_passed = True

    # 1. Check Python
    print("[-] Checking Python version...")
    print(f"    Python {sys.version.split()[0]} is installed.")
    
    # 2. Check Port Availability (Default Port 3000)
    app_port = 3000
    print(f"[-] Checking Port {app_port} availability...")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", app_port))
        print(f"    [OK] Port {app_port} is available.")
    except socket.error:
        print(f"    [ERROR] Port {app_port} is already in use by another process.")
        print(f"            Please stop the application currently using port {app_port}.")
        all_passed = False
    finally:
        s.close()

    # 3. Check dependencies installed
    if framework == "node":
        print("[-] Checking Node dependencies...")
        if not os.path.exists("node_modules"):
            print("    [INFO] node_modules not found. Triggering package installation...")
            try:
                subprocess.run("npm install", shell=True, check=True)
                print("    [OK] Dependencies installed successfully.")
            except subprocess.CalledProcessError:
                print("    [ERROR] npm install failed. Please install dependencies manually.")
                all_passed = False
        else:
            print("    [OK] node_modules is present.")

    # 3a. Check Docker Status
    print("[-] Checking Docker status...")
    try:
        res = subprocess.run(["docker", "info"], capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            # Get basic details to show active access status
            container_count = 0
            for line in res.stdout.splitlines():
                if line.strip().startswith("Containers:"):
                    container_count = line.split(":")[1].strip()
                    break
            print(f"    [OK] Docker Connected (Available container count: {container_count}).")
        else:
            print("    [WARNING] Docker Not Connected (Daemon is not responding).")
    except FileNotFoundError:
        print("    [WARNING] Docker Not Connected (Docker CLI not found).")
    except subprocess.TimeoutExpired:
        print("    [WARNING] Docker Not Connected (Docker info command timed out).")

    # 3. Check Ollama
    print("[-] Checking Ollama connection...")
    
    # Read Ollama url and model from .env if present
    ollama_url = "http://127.0.0.1:11434"
    ollama_model = "llama3"
    if os.path.exists(".env"):
        try:
            with open(".env", "r") as f:
                for line in f:
                    if line.strip().startswith("OLLAMA_URL="):
                        ollama_url = line.split("=")[1].strip().strip('"').strip("'")
                    if line.strip().startswith("OLLAMA_MODEL="):
                        ollama_model = line.split("=")[1].strip().strip('"').strip("'")
        except:
            pass

    try:
        # Check service ping
        req = urllib.request.Request(ollama_url, method="GET")
        with urllib.request.urlopen(req, timeout=3) as response:
            if response.status == 200:
                print(f"    [OK] Ollama service is active on {ollama_url}")
                
                # Check models catalog
                try:
                    tags_url = f"{ollama_url.rstrip('/')}/api/tags"
                    tags_req = urllib.request.Request(tags_url, method="GET")
                    with urllib.request.urlopen(tags_req, timeout=3) as tags_resp:
                        import json
                        tags_data = json.loads(tags_resp.read().decode('utf-8'))
                        models = [m["name"].split(":")[0].lower() for m in tags_data.get("models", [])]
                        
                        clean_model = ollama_model.split(":")[0].lower()
                        if clean_model in models or any(clean_model in m for m in models):
                            print(f"    [OK] Model '{ollama_model}' is downloaded and loaded.")
                        else:
                            print(f"    [WARNING] Active model '{ollama_model}' not found in Ollama catalog.")
                            print(f"              Please pull the model by running:")
                            print(f"              ollama pull {ollama_model}")
                except Exception as model_err:
                    print(f"    [WARNING] Unable to check Ollama models catalog: {model_err}")
            else:
                print(f"    [WARNING] Ollama status checks returned code {response.status}")
    except Exception as e:
        print(f"    [WARNING] Unable to connect to Ollama on {ollama_url}: {e}")
        print("              Please ensure Ollama is launched ('ollama serve').")
        print("              (Application will boot using Rule-Based Fallback AI mode)")

    # 4. Check Environment Binding Settings
    print("[-] Checking host binding configurations...")
    env_host = "localhost"
    if os.path.exists(".env"):
        with open(".env", "r") as f:
            for line in f:
                if line.strip().startswith("HOST="):
                    env_host = line.split("=")[1].strip().strip('"').strip("'")
    if env_host not in ["localhost", "127.0.0.1"]:
        print(f"    [WARNING] Host is currently bound to '{env_host}' in your .env configuration.")
        print("              For safe local-only loopback access, set: HOST=\"localhost\"")

    if not all_passed:
        print_banner("VALIDATION FAILED")
        print("Please address the issues highlighted above before launching.")
    else:
        print_banner("ALL CHECKS PASSED")
        
    return all_passed

def get_run_instructions(framework):
    instructions = f"""
============================================================
LOCAL RUN INSTRUCTIONS (Step-by-Step Commands)
============================================================
1. Create a Python Virtual Environment:
   python -m venv venv

2. Activate the Virtual Environment:
   Windows Command Prompt:   venv\\Scripts\\activate.bat
   Windows PowerShell:       .\\venv\\Scripts\\Activate.ps1
   Linux/macOS:              source venv/bin/activate

3. Install required Python tools:
   pip install -r requirements.txt

4. Launch the main application server:
"""
    if framework == "node":
        instructions += "   npm run dev\n"
    elif framework == "streamlit":
        instructions += "   streamlit run app.py --server.port 8501 --server.address 127.0.0.1\n"
    elif framework == "flask":
        instructions += "   python -m flask run --host 127.0.0.1 --port 3000\n"
    elif framework == "fastapi":
        instructions += "   uvicorn main:app --host 127.0.0.1 --port 3000\n"

    instructions += """
5. Access the UI:
   Local Loopback:   http://localhost:3000
   Alternate IP:     http://127.0.0.1:3000
"""
    return instructions

def main():
    print_banner("DOCKER HEALTH DASHBOARD LOCAL RUNNER")
    framework = detect_framework()
    
    # Run startup checks
    checks_passed = run_startup_checks(framework)
    
    # Print run instructions
    print(get_run_instructions(framework))
    
    if not checks_passed:
        print("Application cannot start automatically due to missing prerequisites.")
        sys.exit(1)

    # Run application command
    connector_proc = None
    if framework == "node":
        print("\n[INFO] Starting Local Connector in the background...")
        try:
            if os.name == 'nt':
                connector_proc = subprocess.Popen("npm.cmd run connector", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                connector_proc = subprocess.Popen("npm run connector", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("    [OK] Local Connector started on http://127.0.0.1:43210")
        except Exception as e:
            print(f"    [WARNING] Failed to start local connector automatically: {e}")
            print("              You may need to run 'npm run connector' manually in another terminal.")

    print("\nStarting application server...")
    time.sleep(1)
    
    # Open browser
    webbrowser.open("http://localhost:3000")
    
    if framework == "node":
        cmd = "npm run dev"
    else:
        cmd = "npm run dev" # Fallback

    try:
        subprocess.run(cmd, shell=True)
    except KeyboardInterrupt:
        print("\nShutting down local application server safely.")
    finally:
        if connector_proc:
            print("[INFO] Shutting down Local Connector...")
            if os.name == 'nt':
                try:
                    subprocess.run(f"taskkill /F /T /PID {connector_proc.pid}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except:
                    pass
            else:
                try:
                    connector_proc.terminate()
                except:
                    pass

if __name__ == "__main__":
    main()
