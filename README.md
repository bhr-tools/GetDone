# Get Done

A fast, self-hosted personal task manager inspired by the original spirit of Todoist, built around the principles of **slow tech** and **minimalism**:
- **Vibe coded:** After using this kind of tools for 4+ years, I needed to create my own, that would do exactly what I wanted, extremely well, without the cost of opportunity of learning how to do everthing myself in a domain (web dev) where I don't want/need to be an expert.

- **Zero bloat:** No gamification, no karma, no stress-inducing notifications, no AI, no productivity score dashboards.
    
- **Infinite nesting:** Subprojects/folders nested infinitely, and subtasks nested infinitely.
    
- **Full Vim navigation:** Fully operable via keyboard (`j`/`k`, `o`/`O`, `x`, `dd`, `Tab`/`Shift+Tab`, `p`, `r`, `t`, `u`, `?`).
    
- **Deterministic Quick Add:** Instant offline token parsing for dates, priorities, projects, recurrence, and locations.
    
- **Rosé Pine palette:** Moon (dark) and Dawn (light) themes with Focus blue accents for complete visual calm.
    
- **Locations & Maps:** Add an address or place name to generate a one-click link to Google Maps or Apple Maps.
    
- **Native multi-instance NixOS support:** Single Go binary (~16 MB) with pure-Go embedded SQLite, packaged with Nix Flakes and a multi-instance NixOS module.
    

## Vim Keyboard Shortcuts (Normal Mode)

Press `?` in the application to toggle the interactive help cheatsheet.

|   |   |   |
|---|---|---|
|**Key**|**Action**|**Description**|
|`j` / `k` (or `↓` / `↑`)|Move|Select next or previous task|
|`gg`|Top|Jump to the first task|
|`G`|Bottom|Jump to the last task|
|`o`|Add below|Insert a new task beneath the selected task|
|`O`|Add above|Insert a new task above the selected task|
|`x`|Complete|Complete task (with temporary Undo toast)|
|`dd`|Delete|Permanently delete the task|
|`e` or `Enter`|Edit|Open task detail view or edit task title|
|`Tab`|Indent|Demote task into a subtask of the previous task|
|`Shift + Tab`|Outdent|Promote task up one hierarchy level|
|`p`|Priority|Cycle priority (P1 Urgent -> P2 High -> P3 Normal)|
|`r`|Postpone|Postpone due date by +1 day|
|`t`|Due date|Open prompt to set or modify due date|
|`u`|Undo|Revert / restore last deleted or completed task|
|`/`|Search|Focus quick search / capture field|
|`q`|Quick Add|Open quick add composer from anywhere|
|`?`|Help|Open / close keyboard shortcuts modal|
|`Esc`|Cancel|Exit insert mode (`INSERT`), close active modals|

## Quick Add Syntax

In any capture field (or using `o` / `q`), type naturally:

```
Buy fresh bread tomorrow 6pm #Groceries p1 @Bakery
Weekly team sync every monday 09:30 #[Projects/Dev] p2 @Office
Schedule car maintenance 15 Nov p3 @Central Garage
Morning meditation every day
```

- **Project:** `#Personal` or with spaces `#[My Personal Project]`
    
- **Priority:** `p1`, `p2`, `p3` (or `!1`, `!2`, `!3`)
    
- **Location:** `@Office`, `@10 Downing Street, London` (opens Maps on click)
    
- **Date:** `today`, `tomorrow`, `monday`, `15/10`, `23 oct`, `2026-10-25` (English & French supported)
    
- **Time:** `14:30`, `09:00`, `18h`
    
- **Recurrence:** `every day`, `daily`, `every week`, `weekly`, `every monday`, `every month`, `weekdays`
    

## Installation & Usage

### 1. Standalone Linux / Non-NixOS (Go 1.22+ required)

Get Done is engineered as a single Go binary with embedded SQLite and static web assets. You can build and run it on any Linux distribution:

1. **Clone the repository:**
    
    ```
    git clone https://github.com/ben-hourlier/Get-Done.git
    cd Get-Done
    ```
    
2. **Build the binary:**
    
    ```
    go build -o get-done ./cmd/server
    ```
    
3. **Run the server:**
    
    ```
    ./get-done -host 127.0.0.1 -port 8080 -data-dir ./data
    ```
    
    Open your browser at `http://127.0.0.1:8080`.
    

### 2. Via Nix Flakes (NixOS / Home Manager)

If you use Nix with flakes enabled, you can run or install Get Done directly:

- **Run directly:**
    
    ```
    nix run github:ben-hourlier/Get-Done
    ```
    
- **Add to your Nix Flake inputs:**
    
    ```
    inputs.get-done.url = "github:ben-hourlier/Get-Done";
    ```
    

## NixOS Server Deployment (Multi-Instance)

### 1. How it works under the hood

1. **Single static Go binary:** The application compiles using `pkgs.buildGoModule`. Embedded pure-Go SQLite (`modernc.org/sqlite`) and all static web assets (HTML, CSS, JS) are embedded into the final binary with zero runtime interpreter or dynamic dependencies.
    
2. **Multi-instance NixOS module:** The flake exports `nixosModules.default` (alias `nixosModules.get-done`):
    
    - Dedicated system user and group (`get-done`).
        
    - Dedicated `systemd` service unit per instance (`getdone` for default instance, or `getdone-<name>`).
        
    - Dedicated persistent data directory (`/var/lib/getdone` or `/var/lib/getdone-<name>`) with `StateDirectory` security.
        

### 2. NixOS Configuration Example

Add the repository to your server's `flake.nix` inputs:

```
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    get-done = {
      url = "github:ben-hourlier/Get-Done";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, get-done, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        get-done.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

Then in your `configuration.nix` (or `services/utilities.nix`):

```
{ config, pkgs, ... }: {
  services.get-done = {
    enable = true;
    instances = {
      default = {
        port = 8080;
        host = "127.0.0.1";
      };
      # Example of a second isolated instance:
      # work = {
      #   port = 8081;
      #   host = "127.0.0.1";
      # };
    };
  };
}
```

### 3. Backups

All project, section, task, and recurrence data is stored in a single SQLite database: `/var/lib/getdone/getdone.db` (or `/var/lib/getdone-<name>/getdone.db`). Backing up is as simple as copying this single file.
