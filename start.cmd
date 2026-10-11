@echo off
rem Starts ZX AI in the background and opens it. First run installs dependencies.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run ext
call npm run up
