@echo off
REM Start a local web server so the app can fetch recipes.json and open the browser.
REM Python 3 must be installed and on PATH.
cd /d "%~dp0"
start "" http://localhost:8765/index.html
python -m http.server 8765
