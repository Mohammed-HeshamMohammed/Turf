# Build from the repository folder "Full CRM Turf" so the Cargo workspace is in context:
#   docker build -f services/features/crm/Dockerfile -t turf-crm .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p turf-crm

FROM debian:bookworm-slim
COPY --from=build /src/target/release/turf-crm /usr/local/bin/service
ENV PORT=8115
EXPOSE 8115
USER nobody
CMD ["service"]
