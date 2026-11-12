# Review/pin the base digest and resulting image digest before hosting.
ARG POSTGRES_IMAGE=postgres:16
FROM ${POSTGRES_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0700 /var/lib/pgbackrest /var/log/pgbackrest
