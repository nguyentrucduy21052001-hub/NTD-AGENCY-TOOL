@echo off
chcp 65001 >nul
title NTD Agency - Tu dong hoa Facebook 100%%

echo =======================================================================
echo    NTD AGENCY - TIỆN ÍCH TỰ ĐỘNG ĐIỀN BÀI & ĐĂNG NHÓM FACEBOOK 100%%
echo =======================================================================
echo.
echo Đang nạp Tiện ích mở rộng NTD Agency vào Google Chrome...
echo.

set "EXT_DIR=%~dp0"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

set "CHROME_BIN="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  set "CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
  set "CHROME_BIN=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
  set "CHROME_BIN=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) else (
  set "CHROME_BIN=chrome.exe"
)

echo Đường dẫn thư mục Tiện ích: %EXT_DIR%
echo Đang khởi chạy: %CHROME_BIN%
echo.

start "" "%CHROME_BIN%" --load-extension="%EXT_DIR%" "https://nguyentrucduy21052001-hub.github.io/panel.html"

echo =======================================================================
echo [OK] Đã mở Google Chrome với Tiện ích NTD Agency!
echo      Trang web sẽ tự động kết nối và TỰ ĐỘNG ĐIỀN BÀI 100%% khi đăng.
echo =======================================================================
timeout /t 3 >nul
exit
