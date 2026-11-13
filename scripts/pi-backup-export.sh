#!/bin/sh
# Install as a forced SSH command for the Mac backup key. No arbitrary commands.
set -eu
umask 077
cd /home/ubuntu/seongmin/assignment-alarm

case "${SSH_ORIGINAL_COMMAND:-}" in
  assignment-backup-database-v1)
    exec docker compose --env-file .env.pi exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"'
    ;;
  assignment-backup-images-v1)
    exec docker compose --env-file .env.pi exec -T web tar -czf - -C /app/uploads assignment-images
    ;;
  assignment-backup-config-v1)
    exec tar -czf - .env.pi .runtime/tunnel-token docker-compose.yml deploy/assignment-alarm-tunnel.service -C / etc/systemd/system/assignment-alarm-tunnel.service
    ;;
  *)
    printf 'This key permits assignment backups only.\n' >&2
    exit 126
    ;;
esac
