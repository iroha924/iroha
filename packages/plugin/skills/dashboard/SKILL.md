---
name: dashboard
description: Open the local iroha review dashboard, where a human approves or rejects candidate knowledge and browses the memory graph. Use when the user wants to review the iroha queue, approve or reject candidates, or open the dashboard. Do not use for unrelated local web servers or UIs.
---

# Open the iroha dashboard

Launch the local dashboard (binds to `127.0.0.1` on a random port and opens the browser):

```bash
iroha dashboard
```

The dashboard is the only place candidates are approved or rejected — agents cannot approve knowledge. Approval writes a canonical file into `.iroha/`, which the user then commits. The server runs only while the command is running; stop it with Ctrl-C.
