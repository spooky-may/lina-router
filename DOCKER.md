# Docker

This project ships with a `Dockerfile` for building and running 9Router in a container.

## Build image

```bash
docker build -t lina-router .
```

## Start container

```bash
docker run --rm \
  -p 20128:20128 \
  -v "$HOME/.lina-router:/app/data" \
  -e DATA_DIR=/app/data \
  --name lina-router \
  lina-router
```

The app listens on port `20128` in the container.

## What the volume does

```bash
-v "$HOME/.lina-router:/app/data" \
-e DATA_DIR=/app/data
```

`lina-router` stores its database at `path.join(DATA_DIR, "db.json")`.
Without `DATA_DIR`, the app falls back to the current user's home directory (for example `~/.lina-router/db.json` on macOS/Linux). In the container, set `DATA_DIR=/app/data` so the bind mount is actually used.

With the example above, the database file is:

```text
/app/data/db.json
```

and it is persisted on the host at:

```text
$HOME/.lina-router/db.json
```

## Stop container

```bash
docker stop lina-router
```

## Run in background

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.lina-router:/app/data" \
  -e DATA_DIR=/app/data \
  --name lina-router \
  lina-router
```

## View logs

```bash
docker logs -f lina-router
```

## Optional environment variables

You can override runtime env vars with `-e`.

Example:

```bash
docker run --rm \
  -p 20128:20128 \
  -v "$HOME/.lina-router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name lina-router \
  lina-router
```

## Rebuild after code changes

```bash
docker build -t lina-router .
```

Then restart the container.
