# The instance-updater sidecar (docs/instance-updater.md). Build from the repo root:
#   docker build -f docker/updater/Dockerfile -t screentinker-updater .
#
# docker:cli is alpine + busybox + the docker CLI with the compose plugin — everything
# scripts/updater/st-updater.sh needs in docker mode. It holds docker.sock, so it does nothing but
# watch for requests the app writes; it never pulls anything it was not asked to.
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d
RUN apk add --no-cache curl
COPY scripts/updater/st-updater.sh /usr/local/bin/st-updater.sh
RUN chmod 755 /usr/local/bin/st-updater.sh
ENV UPDATER_MODE=docker \
    UPDATER_REQUEST_DIR=/data/updater/requests \
    UPDATER_STATUS_DIR=/updater
ENTRYPOINT ["/usr/local/bin/st-updater.sh"]
CMD ["watch"]
