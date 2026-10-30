# Build from the repository folder "Caller Whale CRM" so the Cargo workspace is in context:
#   docker build -f services/auth/Dockerfile -t callerwhale-auth .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
RUN cargo build --release -p callerwhale-auth

FROM debian:bookworm-slim
COPY --from=build /src/target/release/callerwhale-auth /usr/local/bin/service
ENV PORT=8101
EXPOSE 8101
USER nobody
CMD ["service"]
