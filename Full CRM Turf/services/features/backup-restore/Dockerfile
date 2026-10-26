# Build from the repository folder "Full CRM Turf" so the Cargo workspace is in context:
#   docker build -f services/features/backup-restore/Dockerfile -t turf-backup-restore .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p turf-backup-restore

FROM debian:bookworm-slim
COPY --from=build /src/target/release/turf-backup-restore /usr/local/bin/service
ENV PORT=8118
EXPOSE 8118
USER nobody
CMD ["service"]
