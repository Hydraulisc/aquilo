# Aquilo
Light. Fast. Untouchable.

## What's This?
Aquilo is a privacy-first platform for communities, built on the [Hydraulisc](https://hydraulisc.net) ecosystem.
It provides text and media spaces without surveillance, tracking, or hidden data flows.
Aquilo is not designed for growth hacking, user profiling, or behavioral analytics — it exists to keep conversations light, fast, and untouchable.

Because when communities are no longer about coming together, what's the point in having them?

## Roadmaps
- [Aquilo Task Board](https://git.sooox.cc/draulisc-on-forgejo/aquilo/projects/2)
- [Hydraulisc Blog/Aquilo Roadmap](https://blog.hydraulisc.net/blog/aquilo-roadmap-road-to-community) 

## Database
Aquilo stores its data in [PostgreSQL](https://www.postgresql.org/) (version 12 or newer). Tables are created
automatically on first start, but the server, the database and a login for it must exist first.
Data from the old `database.db` (SQLite) is not migrated.

### 1. Install PostgreSQL
- **Debian/Ubuntu:** `sudo apt install postgresql` (it starts automatically)
- **macOS (Homebrew):** `brew install postgresql@17 && brew services start postgresql@17`
- **Windows:** use the installer from postgresql.org and remember the password you set for `postgres`
- **Docker:** `docker run -d --name aquilo-db -p 5432:5432 -e POSTGRES_PASSWORD=change-me postgres:17`

### 2. Create a user and a database
Open a SQL shell as the `postgres` superuser (`sudo -u postgres psql` on Linux, `psql -U postgres` on
macOS/Windows/Docker) and run:

```sql
CREATE USER aquilo WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE aquilo OWNER aquilo;
\q
```

`OWNER aquilo` matters: on PostgreSQL 15+ only the owner may create tables in a database, so without it
Aquilo fails with `permission denied for schema public`.

### 3. Tell Aquilo how to connect
Edit the `db*` fields in `globals.json`:

```json
"dbHost": "localhost",
"dbPort": 5432,
"dbName": "aquilo",
"dbUser": "aquilo",
"dbPassword": "choose-a-strong-password"
```

Or skip the file and set `DATABASE_URL` instead, which takes priority over `globals.json`:

```sh
export DATABASE_URL=postgres://aquilo:choose-a-strong-password@localhost:5432/aquilo
```

> `globals.json` is tracked by git. Don't commit a real password: use `DATABASE_URL` on your server,
> or run `git update-index --skip-worktree globals.json` to keep local edits out of commits.

### 4. Install and start
```sh
npm install
npm start
```

### 5. Check that it worked
```sh
psql -U aquilo -h localhost aquilo -c '\dt'
```
You should see tables such as `servers`, `channels`, `messages` and `users`.

### Troubleshooting
| Error | Cause / fix |
| --- | --- |
| `ECONNREFUSED` | PostgreSQL isn't running, or the host/port is wrong. |
| `password authentication failed for user "aquilo"` | The password in `globals.json` / `DATABASE_URL` doesn't match step 2. |
| `database "aquilo" does not exist` | Step 2 wasn't run, or `dbName` is misspelled. |
| `role "aquilo" does not exist` | Step 2 wasn't run, or `dbUser` is misspelled. |
| `permission denied for schema public` | The database isn't owned by your user: `ALTER DATABASE aquilo OWNER TO aquilo;` |

### Backups
```sh
pg_dump -U aquilo -h localhost aquilo > aquilo-backup.sql      # back up
psql -U aquilo -h localhost aquilo < aquilo-backup.sql         # restore into an empty database
```

## Features
- Free and Open Source
- Self-hostable by design
- Hydraulisc authentication built-in
- No hidden metrics, ads, costs, or profiling
