# Build from the repository folder "Full CRM Turf" so the Cargo workspace is in context:
#   docker build -f services/auth/Dockerfile -t turf-auth .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p turf-auth

FROM debian:bookworm-slim
COPY --from=build /src/target/release/turf-auth /usr/local/bin/service
ENV PORT=8101
EXPOSE 8101
USER nobody
CMD ["service"]
