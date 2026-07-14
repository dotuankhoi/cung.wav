@echo off
rem Đàn Bầu / Đàn Tranh launcher: starts a local server and opens the app.
cd /d "%~dp0"
start "dan-bau-server" /min cmd /c "python -m http.server 8471"
timeout /t 1 /nobreak >nul
start "" http://localhost:8471/index.html
