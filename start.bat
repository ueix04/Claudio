@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Claudio AI Radio
echo   ====================
echo.

if not exist ".env" (
    echo   [!] Missing .env file. Copy .env.example and fill in your config.
    pause
    exit /b 1
)

echo   [+] Config file found.

if not exist "node_modules" (
    echo   [+] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo   [!] npm install failed.
        pause
        exit /b 1
    )
)

echo   [+] Starting backend (http://localhost:3000) ...
echo   [+] Starting frontend (http://localhost:5173) ...
echo.
echo   Press Ctrl+C to stop both services.
echo.

call npm run dev

if errorlevel 1 (
    echo.
    echo   [!] Startup exited with an error.
)

pause
