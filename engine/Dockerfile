# IRC engine image — runs the WebSocket↔IRC bridge as a standalone process.
# Mirrors the backend Dockerfile at the repo root for consistency: same Go
# version, same distroless runtime, same build flags. Differences live in
# the binary path (./engine/cmd/engine) and the exposed port (8080).
FROM golang:1.24 AS builder

WORKDIR /app

COPY go.mod go.sum* ./
COPY . .
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o engine ./engine/cmd/engine

FROM gcr.io/distroless/static-debian12

EXPOSE 8080
WORKDIR /app

COPY --from=builder --chown=nonroot:nonroot /app/engine .

ARG VERSION
ENV VERSION=$VERSION

USER nonroot

ENTRYPOINT ["./engine"]
CMD ["serve"]
