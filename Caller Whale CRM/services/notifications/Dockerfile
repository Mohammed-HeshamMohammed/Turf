FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/service /service
ENV PORT=8102
EXPOSE 8102
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s CMD ["/service", "health"]
ENTRYPOINT ["/service"]
