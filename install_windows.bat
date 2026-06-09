@echo off
echo ============================================
echo  Face Attendance System - Windows Installer
echo ============================================
echo.

:: Activate venv if present
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo Creating virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
)

echo.
echo [1/4] Upgrading pip...
python -m pip install --upgrade pip

echo.
echo [2/4] Installing cmake (needed for dlib)...
pip install cmake

echo.
echo [3/4] Installing dlib...
pip install dlib

echo.
echo [4/4] Installing remaining packages...
pip install -r requirements.txt

echo.
echo ============================================
echo  Installation complete!
echo  Run the app with:  python app.py
echo ============================================
pause
