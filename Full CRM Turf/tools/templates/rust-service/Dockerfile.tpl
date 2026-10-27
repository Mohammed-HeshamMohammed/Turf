# Build from the repository folder "Full CRM Turf" so the Cargo workspace is in context:
#   docker build -f __DIR__/Dockerfile -t turf-__SLUG__ .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p turf-__SLUG__

FROM debian:bookworm-slim
COPY --from=build /src/target/release/turf-__SLUG__ /usr/local/bin/service
ENV PORT=__PORT__
EXPOSE __PORT__
USER nobody
CMD ["service"]
