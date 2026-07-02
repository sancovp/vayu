#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

APP_NAME="Vayu"
APP_BUNDLE_ID="com.vayu.dictation"
HELPER_BUNDLE_ID="com.vayu.dictation.helper"
APP_PATH="/Applications/${APP_NAME}.app"
PACKAGED_DIR="${APP_NAME}-darwin-arm64/${APP_NAME}.app"
SIGN_IDENTITY="${VAYU_CODESIGN_IDENTITY:--}"

clang -O3 helper.cpp -framework CoreGraphics -framework CoreFoundation -lstdc++ -o helper
./node_modules/.bin/electron-packager . "${APP_NAME}" \
  --platform=darwin \
  --arch=arm64 \
  --overwrite \
  --extend-info=extend.plist \
  --icon=assets/vayu.icns \
  --app-bundle-id="${APP_BUNDLE_ID}"

rm -rf "${APP_PATH}"
cp -R "${PACKAGED_DIR}" "${APP_PATH}"
cp helper "${APP_PATH}/Contents/MacOS/helper"
chmod +x "${APP_PATH}/Contents/MacOS/helper"

codesign --force --deep --sign "${SIGN_IDENTITY}" --identifier "${APP_BUNDLE_ID}" "${APP_PATH}"
codesign --force --sign "${SIGN_IDENTITY}" --identifier "${HELPER_BUNDLE_ID}" "${APP_PATH}/Contents/MacOS/helper"
codesign --force --sign "${SIGN_IDENTITY}" --identifier "${APP_BUNDLE_ID}" "${APP_PATH}"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

codesign -dv --verbose=2 "${APP_PATH}" 2>&1 | sed -n '1,20p'
codesign -dv --verbose=2 "${APP_PATH}/Contents/MacOS/helper" 2>&1 | sed -n '1,20p'
