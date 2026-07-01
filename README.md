# pi-paws

Pi coding agent extension for [ai.paws.best](https://ai.paws.best) — an Open WebUI instance with 20+ models.

## Install

```bash
pi extension install github:drvova/ai.paws.best
```

Or manually clone into `~/.pi/extensions/`:

```bash
git clone https://github.com/drvova/ai.paws.best.git ~/.pi/extensions/ai.paws.best
```

## Setup

1. Start Pi: `pi`
2. Run: `/paws login`
3. Enter your email and password

## Commands

- `/paws login` — Sign in with email/password
- `/paws refresh` — Force catalog refresh (re-probes all models)
- `/paws status` — Show auth and catalog status
- `/paws logout` — Sign out

## How it works

- Registers a `paws` provider with live model list from `/api/models`
- Probes each model for reasoning, tool support, and compat flags
- All values come from the backend — zero hardcoded model params
- Streams via SSE from `/api/chat/completions`
- Runs a local proxy on port 18235 for OpenAI SDK compatibility
