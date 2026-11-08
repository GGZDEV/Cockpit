#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cockpit"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ALLOWED_HOSTS=""
TOKEN_SOURCE=""
while (($#)); do
  case "$1" in
    --allowed-hosts) ALLOWED_HOSTS="$2"; shift 2 ;;
    --deployer-token-file) TOKEN_SOURCE="$2"; shift 2 ;;
    *) echo "Option inconnue: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$ALLOWED_HOSTS" || "$ALLOWED_HOSTS" == *://* ]]; then
  echo "Usage: $0 --allowed-hosts IP,nom-dns [--deployer-token-file /chemin/jeton]" >&2
  exit 2
fi
# Dossier d'état (secrets, secret de session, jeton HA) : conservé tel quel d'un déploiement à l'autre.
mkdir -p "$CONFIG_DIR" "$UNIT_DIR" "$HOME/Projets"
chmod 700 "$CONFIG_DIR"
if [[ -n "$TOKEN_SOURCE" ]]; then
  [[ -r "$TOKEN_SOURCE" ]] || { echo "Jeton Deployer illisible: $TOKEN_SOURCE" >&2; exit 1; }
  install -m 600 "$TOKEN_SOURCE" "$CONFIG_DIR/deployer-token"
fi
[[ -s "$CONFIG_DIR/deployer-token" ]] || { echo "Jeton manquant: fournissez --deployer-token-file" >&2; exit 1; }
if [[ ! -s "$CONFIG_DIR/web-password" ]]; then
  "$(command -v node)" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$CONFIG_DIR/web-password"
  chmod 600 "$CONFIG_DIR/web-password"
  echo "Mot de passe web créé dans $CONFIG_DIR/web-password (à conserver hors Git)."
fi
ENV_FILE="$CONFIG_DIR/web.env"
if [[ ! -e "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
COCKPIT_SERVER_MODE=1
HOST=0.0.0.0
PORT=3888
COCKPIT_ALLOWED_HOSTS=$ALLOWED_HOSTS
COCKPIT_WORKSPACES=$HOME/Projets
COCKPIT_DEPLOYER_URL=http://192.168.1.236:8080
COCKPIT_DEPLOYER_TOKEN_FILE=$CONFIG_DIR/deployer-token
COCKPIT_WEB_PASSWORD_FILE=$CONFIG_DIR/web-password
COCKPIT_STATE_DIR=$CONFIG_DIR
COCKPIT_DIRECT=1
COCKPIT_CODEX_DIRECT=0
EOF
  chmod 600 "$ENV_FILE"
else
  echo "Configuration existante conservée: $ENV_FILE"
fi
NODE=$(command -v node)
sed -e "s|@@APP_DIR@@|$APP_DIR|g" -e "s|@@ENV_FILE@@|$ENV_FILE|g" -e "s|@@NODE@@|$NODE|g" \
  "$APP_DIR/deploy/cockpit-web.service.in" > "$UNIT_DIR/cockpit-web.service"
systemctl --user daemon-reload
systemctl --user enable --now cockpit-web.service
systemctl --user --no-pager --full status cockpit-web.service
