@echo off
rem DFO Overlay - update to the latest game release, rebuild with the overlay, play. Options go to launch.mjs.
title DFO Overlay
node "%~dp0launch.mjs" %*
if errorlevel 1 (
  echo.
  echo Something above needs a look. The full log is in "%~dp0logs".
  pause
)
