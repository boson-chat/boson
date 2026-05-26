FROM golang:1.24 AS builder

WORKDIR /app

COPY go.mod go.sum* ./
COPY . .
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main ./backend/cmd/server

FROM gcr.io/distroless/static-debian12

EXPOSE 3000
WORKDIR /app

COPY --from=builder --chown=nonroot:nonroot /app/main .

ARG VERSION
ENV VERSION=$VERSION

USER nonroot

ENTRYPOINT ["./main"]
CMD ["serve"]
