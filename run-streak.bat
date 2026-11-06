@echo off
cd /d "%~dp0"
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
echo [%DATE% %TIME%] --- start --- >> duo.log
%NODE% autoserver.mjs --verify >> duo.log 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] verify gagal, cek duo.alert >> duo.log
  exit /b 1
)
%NODE% autoserver.mjs >> duo.log 2>&1
echo [%DATE% %TIME%] --- exit %ERRORLEVEL% --- >> duo.log
