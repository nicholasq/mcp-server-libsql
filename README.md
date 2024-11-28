# LibSQL Context Server

A Model Context Protocol server that exposes LibSQL/Turso database schema information. Built with Deno 2.0.

## Requirements

- Deno 2.0+
- Turso CLI installed and authenticated
- A LibSQL/Turso database URL

## Usage

Build the binary:
```bash
deno compile --allow-run main.ts
```

Run the server:
```bash
./libsql-context-server <database-url>
```