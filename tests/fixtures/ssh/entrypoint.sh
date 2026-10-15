#!/bin/sh
set -eu

: "${FIXTURE_PASSWORD:?Expected a generated fixture-only password}"
: "${FIXTURE_PUBLIC_KEY:?Expected a generated fixture-only public key}"

printf 'fixture:%s\n' "$FIXTURE_PASSWORD" | chpasswd
mkdir -p /run/sshd /home/fixture/.ssh
printf '%s\n' "$FIXTURE_PUBLIC_KEY" > /home/fixture/.ssh/authorized_keys
chown -R fixture:fixture /home/fixture/.ssh
chmod 0700 /home/fixture/.ssh
chmod 0600 /home/fixture/.ssh/authorized_keys
unset FIXTURE_PASSWORD FIXTURE_PUBLIC_KEY

# Do not reuse image-generated host keys across fixture runs.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
python3 -m http.server 8080 --bind 127.0.0.1 --directory /srv/ssterm-fixture >/tmp/fixture-http.log 2>&1 &
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
