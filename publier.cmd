@echo off
setlocal
cd /d "%~dp0"
call npm run deploy:tablet
if errorlevel 1 (
  echo La publication a echoue. Le message ci-dessus indique pourquoi.
  pause
  exit /b 1
)
echo La tablette est a jour. Vous pouvez fermer cette fenetre.
pause
