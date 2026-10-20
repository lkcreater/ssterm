FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends mosh openssh-server openssh-client python3 procps ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash fixture \
    && mkdir -p /run/sshd

COPY investigate.py /opt/ssterm-mosh/investigate.py
ENV LANG=C.UTF-8
ENTRYPOINT ["python3", "/opt/ssterm-mosh/investigate.py"]
