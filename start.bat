@echo off
cd /d "%~dp0"
set "URL=http://127.0.0.1:5173/"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL%
) else (
  start "" %URL%
)
python serve.py
