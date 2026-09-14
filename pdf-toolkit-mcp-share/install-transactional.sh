#!/bin/bash

set -u

SOURCE_DIR="${1:-}"
TARGET_DIR="${2:-}"

if [ -z "$SOURCE_DIR" ] || [ -z "$TARGET_DIR" ]; then
    echo "Usage: install-transactional.sh <source-directory> <target-directory>" >&2
    exit 2
fi

case "$TARGET_DIR" in
    "/"|"."|"..")
        echo "❌ Refusing unsafe installation target: $TARGET_DIR" >&2
        exit 2
        ;;
esac

SOURCE_DIR="$(cd "$SOURCE_DIR" 2>/dev/null && pwd -P)" || {
    echo "❌ Cannot access share-package source: $SOURCE_DIR" >&2
    exit 2
}
TARGET_PARENT="$(dirname "$TARGET_DIR")"
TARGET_NAME="$(basename "$TARGET_DIR")"

case "$TARGET_NAME" in
    ""|"."|"..")
        echo "❌ Refusing unsafe installation target: $TARGET_DIR" >&2
        exit 2
        ;;
esac
if [ "$TARGET_NAME" != ".pdf-tools-mcp" ]; then
    echo "❌ Refusing unexpected installation target name: $TARGET_NAME" >&2
    exit 2
fi

mkdir -p "$TARGET_PARENT" || exit 1
TARGET_PARENT="$(cd "$TARGET_PARENT" && pwd -P)" || exit 1
TARGET_DIR="$TARGET_PARENT/$TARGET_NAME"
STAGE_DIR="$(mktemp -d "$TARGET_PARENT/${TARGET_NAME}.stage.XXXXXX")" || exit 1
BACKUP_ROOT=""

cleanup_stage() {
    if [ -n "${STAGE_DIR:-}" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf -- "$STAGE_DIR"
    fi
}

cleanup_backup_root() {
    if [ -n "${BACKUP_ROOT:-}" ] && [ -d "$BACKUP_ROOT" ]; then
        rm -rf -- "$BACKUP_ROOT"
    fi
}

rollback_if_needed() {
    if [ -n "${BACKUP_ROOT:-}" ] && [ -e "$BACKUP_ROOT/previous" ] && [ ! -e "$TARGET_DIR" ]; then
        echo "⚠️  Restoring the previous installation before exit." >&2
        if ! mv -- "$BACKUP_ROOT/previous" "$TARGET_DIR"; then
            echo "❌ CRITICAL: automatic rollback failed. Previous installation remains at $BACKUP_ROOT/previous" >&2
            return 1
        fi
    fi
}

cleanup_on_exit() {
    local status=$?
    trap - EXIT HUP INT TERM
    rollback_if_needed || status=2
    cleanup_stage
    if [ -n "${BACKUP_ROOT:-}" ] && [ ! -e "$BACKUP_ROOT/previous" ]; then
        cleanup_backup_root
    fi
    exit "$status"
}

trap 'cleanup_on_exit' EXIT
trap 'exit 130' HUP INT TERM

REQUIRED_ITEMS=(
  "plugins"
    "README.md"
    "SHARE-PROVENANCE.json"
    "SBOM.cdx.json"
    "configure-cursor.sh"
    "dist-ui"
    "install-transactional.sh"
    "install.command"
    "install.sh"
    "package-lock.json"
    "package.json"
    "scripts"
    "server"
    "smart-install.sh"
    "vendor"
)

for item in "${REQUIRED_ITEMS[@]}"; do
    if [ ! -e "$SOURCE_DIR/$item" ]; then
        echo "❌ Share package is incomplete; missing $item" >&2
        exit 1
    fi
    cp -R "$SOURCE_DIR/$item" "$STAGE_DIR/" || exit 1
done
chmod +x "$STAGE_DIR"/*.sh "$STAGE_DIR"/*.command

echo "📦 Installing the reviewed dependency graph in an isolated staging directory..."
if ! (cd "$STAGE_DIR" && npm ci --omit=dev --engine-strict --no-audit --no-fund); then
    echo "❌ Locked dependency installation failed; the existing installation was not changed." >&2
    exit 1
fi

if [ -e "$TARGET_DIR" ]; then
    BACKUP_ROOT="$(mktemp -d "$TARGET_PARENT/${TARGET_NAME}.backup.XXXXXX")" || exit 1
    if ! mv -- "$TARGET_DIR" "$BACKUP_ROOT/previous"; then
        echo "❌ Could not stage the existing installation for replacement; it was not changed." >&2
        cleanup_backup_root
        BACKUP_ROOT=""
        exit 1
    fi
fi

if ! mv -- "$STAGE_DIR" "$TARGET_DIR"; then
    echo "❌ Could not activate the staged installation; attempting rollback." >&2
    if [ -n "$BACKUP_ROOT" ] && [ -e "$BACKUP_ROOT/previous" ]; then
        if ! mv -- "$BACKUP_ROOT/previous" "$TARGET_DIR"; then
            echo "❌ CRITICAL: automatic rollback failed. Previous installation remains at $BACKUP_ROOT/previous" >&2
            BACKUP_ROOT=""
            exit 2
        fi
    fi
    cleanup_backup_root
    BACKUP_ROOT=""
    exit 1
fi
STAGE_DIR=""

cleanup_backup_root
BACKUP_ROOT=""
trap - EXIT HUP INT TERM

echo "✅ Locked dependencies installed and activated transactionally at $TARGET_DIR"
