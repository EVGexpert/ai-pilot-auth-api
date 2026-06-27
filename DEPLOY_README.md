# Auth API Deployment

## Current deploy status
- Last push: AUTH_PREFIX fix + siteUrl param + user field
- Docker: node:24-alpine, 384MB heap limit
- DB: SQLite via Docker named volume (aipilot-auth-data)
- Port: 3001 (internal)
