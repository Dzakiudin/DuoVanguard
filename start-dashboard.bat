@echo off
cd /d "%~dp0"
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
echo Menjalankan DuoVanguard v4.2 Self-Hosted Dashboard...
start "" "http://127.0.0.1:8791"
%NODE% ui.mjs
pause
