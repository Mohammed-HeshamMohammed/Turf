FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/service /service
ENV PORT=__PORT__
EXPOSE __PORT__
USER nonroot
ENTRYPOINT ["/service"]
