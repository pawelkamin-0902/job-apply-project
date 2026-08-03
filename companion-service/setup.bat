@echo off
cd /d "%~dp0"
python -m venv venv
call venv\Scripts\activate.bat
pip install -r requirements.txt
playwright install chromium
echo.
echo Setup complete. Run start.bat to launch the companion service.
pause
