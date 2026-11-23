# probe

Generic HTTP status checker for GitHub Actions. No dependencies.

It reads lists of `label|address` lines from repository secrets, requests each
address and keeps only the status code. A failure counts when it repeats
inside the same run (3 attempts, 30 s apart). A message is sent when a
label goes down and when it comes back; nothing is sent while the state does
not change.

## Configuration

Secrets: `LIST_A`, `LIST_B` (one `label|address` per line), `TG_TOKEN`,
`TG_CHAT`, and optionally `PING_URL`.
Variable: `QUIET_HOURS` (for example `23-08`, Europe/Madrid time; messages
sent in that window are silent).

## Tests

    node --test
