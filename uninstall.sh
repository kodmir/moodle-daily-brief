#!/bin/bash
PLIST="$HOME/Library/LaunchAgents/com.moodlebrief.agent.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Zamanlama kaldırıldı. Klasörü silmek istersen: rm -rf \"$(cd "$(dirname "$0")" && pwd)\""
