@echo off
REM ── EVOLVE stopper (double-click me) ────────────────────────────────
REM ASCII-only for the same reason as START-EVOLVE.cmd.
chcp 65001 >nul
title EVOLVE - stop
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto npmfallback

node scripts\app-stop.ts %*
if errorlevel 1 goto failed
goto done

:npmfallback
echo [EVOLVE] node not found on PATH; falling back to npm.
call npm run app:stop
if errorlevel 1 goto failed
goto done

:failed
echo.
echo [EVOLVE] something is still running - see the messages above.
pause

:done
