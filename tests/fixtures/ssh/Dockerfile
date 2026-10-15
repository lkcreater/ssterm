FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash fixture \
    && mkdir -p /run/sshd /srv/ssterm-fixture \
    && printf 'ssterm-fixture-ok\n' > /srv/ssterm-fixture/index.html

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/ssterm-fixture-entrypoint
RUN chmod 0755 /usr/local/bin/ssterm-fixture-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/ssterm-fixture-entrypoint"]
