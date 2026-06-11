@echo off
set "PATH=C:\Program Files\nodejs;C:\Users\cody\AppData\Roaming\npm;%PATH%"
set "PATHEXT=.COM;.EXE;.BAT;.CMD"
cd /d C:\Users\cody\cortextos
echo === 590-bundle apply run %date% %time% === >> C:\Users\cody\cortextos\apply-590.log
"C:\Program Files\nodejs\node.exe" "C:\Users\cody\AppData\Roaming\npm\node_modules\pm2\bin\pm2" restart ecosystem.config.js --only cortextos-daemon >> C:\Users\cody\cortextos\apply-590.log 2>&1
if errorlevel 1 (
  echo RESTART FAILED errorlevel %errorlevel% >> C:\Users\cody\cortextos\apply-590.log
  exit /b 1
)
"C:\Program Files\nodejs\node.exe" "C:\Users\cody\AppData\Roaming\npm\node_modules\pm2\bin\pm2" save >> C:\Users\cody\cortextos\apply-590.log 2>&1
echo APPLY COMPLETE >> C:\Users\cody\cortextos\apply-590.log
