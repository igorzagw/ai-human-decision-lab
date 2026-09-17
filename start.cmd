@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   AI-Human Decision Lab
echo   ---------------------
echo   Застосунок: http://127.0.0.1:8080
echo   Зупинити:   закрийте це вікно або натисніть Ctrl+C
echo.

rem Браузер відкриваємо з невеликою затримкою, щоб сервер устиг піднятися.
start "" /min cmd /c "timeout /t 1 >nul & start "" http://127.0.0.1:8080"

node serve.mjs 8080

rem Якщо node завершився з помилкою, вікно не має зникнути миттєво:
rem інакше причину побачити неможливо.
if errorlevel 1 (
  echo.
  echo   Не вдалося запустити сервер. Перевірте, чи встановлено Node.js.
  pause
)
