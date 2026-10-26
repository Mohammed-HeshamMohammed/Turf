# Build from the repository folder "Full CRM Turf" so the Cargo workspace is in context:
#   docker build -f services/features/leads-map/Dockerfile -t turf-leads-map .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p turf-leads-map

FROM debian:bookworm-slim
COPY --from=build /src/target/release/turf-leads-map /usr/local/bin/service
ENV PORT=8114
EXPOSE 8114
USER nobody
CMD ["service"]
