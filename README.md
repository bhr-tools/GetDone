# Get Done

A fast, self-hosted personal task manager inspired by the original spirit of Todoist, built around the principles of **slow tech** and **minimalism**:

- **Vibe coded:** After using this kind of tool for 4+ years, I needed to create my own, that would do exactly what I wanted, extremely well, without the opportunity cost of learning everything myself in a domain (web dev) where I don't want/need to be an expert.
- **Zero bloat:** No gamification, no karma, no stress-inducing notifications, no AI, no productivity score dashboards.
- **Infinite nesting:** Projects nest in projects, tasks nest in tasks, without depth limit.
- **Full Vim navigation:** Fully operable from the keyboard.
- **Deterministic Quick Add:** Instant offline parsing of dates, times, priorities, recurrences and locations, in English and French.
- **Rosé Pine palette:** Moon (dark) and Dawn (light) themes, following the system setting.
- **Locations:** Add an address or place name to get a one-click Google Maps link.
- **One binary:** A single Go binary with embedded SQLite and web app, packaged with Nix Flakes (multi-instance NixOS module) and Docker.

## Keyboard shortcuts

Press `?` in the app to show the cheatsheet.

| Key | Action |
|---|---|
| `j` / `k` (or `↓` / `↑`) | Next / previous task |
| `gg` / `G` | First / last task |
| `h` / `l` | Focus the sidebar / the tasks |
| `Enter` or `e` | Open the task (in the sidebar: open the project) |
| `a` | Add a task below the selected one |
| `q` | Quick add to the inbox |
| `d` | Complete (with an Undo button) |
| `u` | Undo the last completion |
| `1` `2` `3` (or `&` `é` `"` on AZERTY) | Set priority P1 / P2 / P3 |
| `Space` | Select / unselect (then act on the whole selection) |
| `m` | Move to a project |
| `s` | Move to a section (in Upcoming: reschedule to a day) |
| `Shift+J` / `Shift+K` | Move the task down / up (manual order only) |
| `Shift+L` / `Shift+H` | Make it a subtask of the task above / un-nest it |
| `/` | Search tasks and projects |
| `Esc` | Close, leave a field, clear the selection |

In the sidebar, `j`/`k` browse the projects, `Shift+J`/`Shift+K` reorder them and `Shift+L`/`Shift+H` nest or un-nest them.
In a task's details, `Enter` edits the title, `a` adds a subtask and `Ctrl+Enter` saves the description.

Tasks, sections and projects can also be dragged with the mouse, or with a long press on touch screens.
Reordering follows the manual order: when a list is sorted by date, priority or title, tasks can still be nested or moved to another section or project, but not reordered. In Upcoming, dropping a task on a day reschedules it, and "Reschedule to today" moves every overdue task to today.

## Quick Add syntax

In any task field, type naturally:

```
Buy fresh bread tomorrow 6pm p1 @Bakery
Weekly team sync every monday 09:30 p2 @Office
Schedule car maintenance 15 Nov p3 @"Central Garage"
Morning meditation every day
```

- **Priority:** `p1`, `p2`, `p3` (or `!1`, `!2`, `!3`)
- **Location:** `@Office`, `@10 Downing Street, London` (everything after `@`), or `@"Café de Flore"` (quoted)
- **Date:** `today`, `tomorrow`, `friday`, `this weekend`, `15/10`, `23 oct`, `2026-10-25` (English & French)
- **Time:** `14:30`, `9am`, `18h`
- **Recurrence:** `every day`, `daily`, `every week`, `every monday`, `every month`, `every year`, `weekdays`, or a cron rule `cron:0 9 * * 1`

Recognized parts are shown as chips while typing; click a chip to keep that text in the title instead.

## Installation & usage

### Docker

```
git clone https://github.com/bhr-tools/GetDone.git
cd GetDone
docker compose up -d --build
```

Open http://127.0.0.1:8766. The database lives in the `getdone-data` volume.

### Standalone (Go 1.26+)

```
go build -o getdone ./cmd/server
./getdone -host 127.0.0.1 -port 8080 -data-dir ./data
```

Every flag can also be set with an environment variable: `HOST`, `PORT`, `DATA_DIR`, `DB_PATH` (overrides the data directory) and `NO_AUTH=true` (no master password, for instances behind your own authentication).

### Nix Flakes

```
nix run github:bhr-tools/GetDone
```

## NixOS server deployment (multi-instance)

The flake exports `nixosModules.default` (alias `nixosModules.getdone`). Each instance gets its own hardened `systemd` service (`getdone` for the instance named `default`, `getdone-<name>` otherwise), running as the `getdone` user, with its data in `/var/lib/getdone` (or `/var/lib/getdone-<name>`).

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    getdone = {
      url = "github:bhr-tools/GetDone";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, getdone, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        getdone.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

Then in your `configuration.nix`:

```nix
{
  services.getdone = {
    enable = true;
    instances = {
      default = {
        port = 8080;
        host = "127.0.0.1";
      };
      # A second, isolated instance:
      # work = {
      #   port = 8081;
      #   host = "127.0.0.1";
      # };
    };
  };
}
```

Instance options: `port`, `host`, `dataDir`, `dbPath`, `noAuth`, `user`, `group`, `openFirewall`.

When serving over HTTPS through a reverse proxy, forward the `X-Forwarded-Proto` header so that the session cookie is marked secure.

## Backups

All data (projects, sections, tasks, password hash and sessions) is stored in a single SQLite file: `getdone.db` in the data directory (`/var/lib/getdone/getdone.db` on NixOS, the `getdone-data` volume with Docker). The database runs in WAL mode: back it up with `sqlite3 getdone.db ".backup backup.db"`, or copy `getdone.db` together with its `-wal` file while the service is stopped.

## Development

```
go vet ./... && go test ./...           # server
node --test tests/js/*.test.mjs         # quick add parser and date helpers
sh tests/e2e/run.sh                     # browser tests (Docker, Playwright)
```
