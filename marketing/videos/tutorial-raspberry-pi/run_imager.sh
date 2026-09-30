#!/bin/bash
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
sleep 3
# QT_QPA_PLATFORM xcb on the virtual display; disable GL for swrast
QT_QUICK_BACKEND=software rpi-imager &
wait
