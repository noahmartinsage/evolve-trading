@echo off
REM ── EVOLVE launcher (double-click me) ───────────────────────────────
REM ASCII-only on purpose: this file lives under a path with Chinese
REM characters, and cmd.exe reads .cmd/.bat with the OEM codepage.
REM Non-ASCII content here gets mangled into unparsable garbage.
REM All Chinese output comes from node (UTF-8) after "chcp 65001".
chcp 65001 >nul
title EVOLVE
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto npmfallback

node scripts\app.ts %*
if errorlevel 1 goto failed
goto done

:npmfallback
echo [EVOLVE] node not found on PATH; falling back to npm.
call npm run app -- %*
if errorlevel 1 goto failed
goto done

:failed
echo.
echo [EVOLVE] startup failed - see the messages above.
echo [EVOLVE] data\app-stack.log keeps the same output for later reading.
pause

:done
