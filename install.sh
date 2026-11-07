#!/bin/bash
# Kullanım: ./install.sh [SAAT] [DAKİKA]   (varsayılan 07:30)
# Tekrar çalıştırmak güvenlidir: .env ve data/ korunur.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HOUR="${1:-7}"
MIN="${2:-30}"
LABEL="com.moodlebrief.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "$DIR" in
  */Documents/*|*/Desktop/*|*/Downloads/*|*"Mobile Documents"*)
    echo "⚠️  Klasör Documents/Desktop/Downloads/iCloud içinde. macOS izinleri yüzünden zamanlanmış çalıştırma"
    echo "   engellenebilir. Klasörü ~/moodle-brief konumuna taşıyıp tekrar çalıştır."
    exit 1 ;;
esac
case "$DIR" in
  *" "*) echo "⚠️  Klasör yolunda boşluk var ($DIR). ~/moodle-brief konumuna taşı."; exit 1 ;;
esac

command -v python3 >/dev/null || { echo "python3 yok. Önce: xcode-select --install"; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9+ gerekli."; exit 1; }

echo "→ Python ortamı kuruluyor..."
[ -x "$DIR/.venv/bin/python" ] || python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install -q --upgrade pip
"$DIR/.venv/bin/pip" install -q -r "$DIR/requirements.txt"

mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
chmod 600 "$DIR/.env"

# Gönderim saatini .env'e yaz (sadece SEND_TIME satırına dokunur)
SEND_TIME="$(printf '%02d:%02d' "$HOUR" "$MIN")"
"$DIR/.venv/bin/python" - "$DIR/.env" "$SEND_TIME" <<'PY'
import re, sys
p, t = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read()
if re.search(r"(?m)^SEND_TIME=", s):
    s = re.sub(r"(?m)^SEND_TIME=.*$", f"SEND_TIME={t}", s)
else:
    s = s.rstrip("\n") + f"\n# Brifingin gönderileceği saat (Mac kapalıysa açılınca gönderilir)\nSEND_TIME={t}\n"
open(p, "w", encoding="utf-8").write(s)
PY

echo "→ Zamanlanıyor: her gün $SEND_TIME (Mac o saatte kapalıysa açıldığında)..."
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/.venv/bin/python</string>
    <string>$DIR/moodle_brief.py</string>
    <string>run</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <!-- tam saatinde -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MIN</integer>
  </dict>
  <!-- Mac o saatte kapalı/çevrimdışıysa: 30 dk'da bir ve açılışta tekrar dener (günde tek gönderim) -->
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DIR/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/launchd.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo ""
echo "✅ Kuruldu. Sıradaki adımlar (ilk kurulumsa):"
echo "   1) .env dosyasını doldur:   open -e \"$DIR/.env\"   (doldurup kaydet ve KAPAT)"
echo "   2) Telegram'ı bağla:        $DIR/.venv/bin/python $DIR/moodle_brief.py setup-telegram"
echo "   3) Dersleri kontrol et:     $DIR/.venv/bin/python $DIR/moodle_brief.py courses"
echo "   4) İlk tarama:              $DIR/.venv/bin/python $DIR/moodle_brief.py init"
echo "   5) Deneme gönderimi:        $DIR/.venv/bin/python $DIR/moodle_brief.py run --force"
