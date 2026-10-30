# Build from the repository folder "Caller Whale CRM" so the Cargo workspace is in context:
#   docker build -f services/features/crm/Dockerfile -t callerwhale-crm .
FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p callerwhale-crm

FROM debian:bookworm-slim
COPY --from=build /src/target/release/callerwhale-crm /usr/local/bin/service
ENV PORT=8115
EXPOSE 8115
USER nobody
CMD ["service"]
