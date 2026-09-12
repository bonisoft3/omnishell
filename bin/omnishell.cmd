@echo off
REM The PATH entry of an installed terminal on Windows, which resolves a bare
REM `omnishell` only through a PATHEXT extension: what `mise install
REM github:bonisoft3/omnishell` puts in front of `omnishell check markup .`.
pwsh -NoProfile -File "%~dp0omnishell.ps1" %*
exit /b %ERRORLEVEL%
