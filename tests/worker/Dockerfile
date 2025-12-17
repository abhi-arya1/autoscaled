# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS build

# Set destination for COPY
WORKDIR /app

# Download any Go modules
COPY container_src/go.mod ./
RUN go mod download

# Copy container source code
COPY container_src/*.go ./

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o /server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /server /server
# Copy pre-built monitor executable from local directory
COPY monitor /monitor
EXPOSE 8080 81

# Use monitor in exec mode: monitor runs on port 81 and execs the server
CMD ["/monitor", "-port", "81", "/server"]
