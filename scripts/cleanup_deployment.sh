#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <ownerHash> <name> <port> <dir>" >&2
  exit 2
}

[[ $# -eq 4 ]] || usage

OWNER_HASH=$1
PROJECT_NAME=$2
PORT=$3
PROJECT_DIR=$4
TAIWEI_ROOT=${TAIWEI_HOME:-"$HOME/.taiwei"}
PROJECTS_ROOT="$TAIWEI_ROOT/projects"
NGINX_HELPER="$TAIWEI_ROOT/skills/taiwei-编程部署/scripts/nginx_deploy.py"

[[ $OWNER_HASH =~ ^[a-f0-9]{8,64}$ ]] || { echo "[fail] invalid ownerHash" >&2; exit 2; }
[[ $PROJECT_NAME =~ ^[a-z0-9-]{1,64}$ ]] || { echo "[fail] invalid project name" >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { echo "[fail] port must be 1-65535" >&2; exit 2; }
[[ $PROJECT_DIR = /* ]] || { echo "[fail] project dir must be absolute" >&2; exit 2; }
case "/$PROJECT_DIR/" in
  */../*) echo "[fail] project dir must not contain '..' path components" >&2; exit 2 ;;
esac

if command -v realpath >/dev/null 2>&1; then
  PROJECTS_ROOT=$(realpath -m -- "$PROJECTS_ROOT")
  PROJECT_DIR=$(realpath -m -- "$PROJECT_DIR")
fi
case "$PROJECT_DIR" in
  "$PROJECTS_ROOT"/*) ;;
  *) echo "[fail] refusing to delete outside $PROJECTS_ROOT: $PROJECT_DIR" >&2; exit 2 ;;
esac

stop_port() {
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    if fuser -k -TERM "${PORT}/tcp" >/dev/null 2>&1; then
      echo "[ok] stopped process on port $PORT with fuser"
    else
      echo "[skip] no process found on port $PORT (fuser)"
    fi
    return
  elif command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port"$" { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART + 4, RLENGTH - 4); $0=substr($0, RSTART + RLENGTH) } }' || true)
  else
    echo "[fail] cannot inspect port $PORT: lsof, fuser, and ss are unavailable"
    return
  fi
  if [[ -z $pids ]]; then
    echo "[skip] no process is listening on port $PORT"
    return
  fi
  local failed=0 pid
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || failed=1; done
  sleep 0.5
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || failed=1; fi
  done
  if (( failed == 0 )); then echo "[ok] stopped PID(s) ${pids//$'\n'/, } on port $PORT";
  else echo "[fail] could not stop every process on port $PORT"; fi
}

delete_files() {
  if rm -rf -- "$PROJECT_DIR"; then
    echo "[ok] deleted all project files: $PROJECT_DIR"
  else
    echo "[fail] could not delete project files: $PROJECT_DIR"
  fi
}

remove_nginx() {
  if [[ ! -f $NGINX_HELPER ]]; then
    echo "[fail] nginx helper not found: $NGINX_HELPER"
    return
  fi
  if python3 "$NGINX_HELPER" "$OWNER_HASH" "$PROJECT_NAME" --remove; then
    echo "[ok] removed nginx proxy"
  elif command -v sudo >/dev/null 2>&1 && sudo -n python3 "$NGINX_HELPER" "$OWNER_HASH" "$PROJECT_NAME" --remove; then
    echo "[ok] removed nginx proxy with sudo"
  else
    echo "[fail] could not remove nginx proxy (run with sufficient permissions)"
  fi
}

set +e
stop_port
delete_files
remove_nginx
set -e
