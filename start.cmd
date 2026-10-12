@echo off
rem Zapusk zastosunku. Tilky ASCII: cmd.exe ne chytaye UTF-8 u .cmd faylah,
rem i kyrylytsya rozpadayetsya na ulamky, yaki vin prymaye za komandy.
cd /d "%~dp0"

echo.
echo   AI-Human Decision Lab
echo   =====================
echo.
echo   Adresa:  http://127.0.0.1:8080
echo.
echo   Ne zakryvay tse vikno - poky vono vidkryte, sayt pratsyuye.
echo.

start "" /min cmd /c "timeout /t 1 >nul & start "" http://127.0.0.1:8080"

node serve.mjs 8080

echo.
echo   Server zupyneno. Mozhlyvo, ne vstanovleno Node.js
echo   abo port 8080 vzhe zaynyatyy.
echo.
pause
