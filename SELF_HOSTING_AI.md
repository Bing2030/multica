# Self-Hosting Setup (for AI Agents)

This document is designed for AI agents to execute. Follow these steps exactly to deploy a local Multica instance and connect to it.

## Prerequisites

- Docker and Docker Compose installed
- Homebrew installed (for CLI)
- At least one AI agent CLI on PATH: `claude` or `codex`

## Install

```bash
# Start the self-host server (backend, frontend, database)
git clone https://github.com/multica-ai/multica.git
cd multica
make selfhost

# Install the CLI
brew install multica-ai/tap/multica

# Create the daemon config (~/.multica/config.json) and start it
mkdir -p ~/.multica
cat > ~/.multica/config.json <<EOF
{
  "server_url": "http://localhost:8080",
  "app_url": "http://localhost:3000",
  "token": "<your-personal-access-token>"
}
EOF
multica daemon start
```

Wait for `make selfhost` to report the server is ready before starting the daemon. Generate a personal access token in **Settings → Account** in the web UI at http://localhost:3000 after logging in.

**Expected result:**
- Frontend at http://localhost:3000
- Backend at http://localhost:8080
- `multica` CLI installed and daemon connected to localhost

## Alternative: Manual Setup

```bash
git clone https://github.com/multica-ai/multica.git
cd multica
make selfhost
brew install multica-ai/tap/multica

mkdir -p ~/.multica
cat > ~/.multica/config.json <<EOF
{
  "server_url": "http://localhost:8080",
  "app_url": "http://localhost:3000",
  "token": "<your-personal-access-token>"
}
EOF
multica daemon start
```

The daemon reads `~/.multica/config.json` for its server URL, app URL, and auth token. Log in at http://localhost:3000 (use the emailed code, or the generated code printed in backend logs when Resend is unset) and generate a personal access token in **Settings → Account**.

## Verification

```bash
multica daemon status
```

Should show `running` with detected agents.

## Stopping

```bash
# Stop the daemon
multica daemon stop

# Stop all Docker services
cd multica
make selfhost-stop
```

## Custom Ports

If the default ports (8080/3000) are in use:

1. Edit `.env` and change `PORT` and `FRONTEND_PORT`
2. Run `make selfhost`
3. Set `server_url` and `app_url` in `~/.multica/config.json` to match your custom ports, then `multica daemon start`

## Troubleshooting

- **Backend not ready:** `docker compose -f docker-compose.selfhost.yml logs backend`
- **Frontend not ready:** `docker compose -f docker-compose.selfhost.yml logs frontend`
- **Daemon issues:** `multica daemon logs`
- **Health checks:** `curl http://localhost:8080/health` for liveness, `curl http://localhost:8080/readyz` for dependency-aware readiness
