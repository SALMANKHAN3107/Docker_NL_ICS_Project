@echo off
echo ============================================================
echo  Initializing Local Environment
echo ============================================================

if not exist venv (
    echo [INFO] Creating Python virtual environment in venv folder...
    python -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment. Ensure Python 3 is installed.
        pause
        exit /b 1
    )
)

echo [INFO] Activating virtual environment...
call venv\Scripts\activate.bat

echo [INFO] Installing required dependencies...
pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo [WARNING] Dependency installation failed. Attempting execution anyway...
)

echo.
python run_local.py
pause
