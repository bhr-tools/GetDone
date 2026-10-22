{
  description = "Get Done — Minimalist Todo List with Rosé Pine design & Vim navigation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Supported systems
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];

      # Package definitions per architecture
      systemOutputs = flake-utils.lib.eachSystem supportedSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          packages = rec {
            get-done = pkgs.buildGoModule {
              pname = "get-done";
              version = "1.0.0";
              src = ./.;

              subPackages = [ "cmd/server" ];
              vendorHash = null;

              postInstall = ''
                if [ -f "$out/bin/server" ]; then
                  mv "$out/bin/server" "$out/bin/get-done"
                fi
              '';

              meta = with pkgs.lib; {
                description = "Get Done — Minimalist Todo List with Rosé Pine design & Vim navigation";
                homepage = "https://github.com/ben-hourlier/Get-Done";
                license = licenses.mit;
                mainProgram = "get-done";
              };
            };
            default = get-done;
          };

          apps = rec {
            get-done = flake-utils.lib.mkApp {
              drv = self.packages.${system}.get-done;
              name = "get-done";
            };
            default = get-done;
          };

          devShells.default = pkgs.mkShell {
            buildInputs = with pkgs; [
              go
              gopls
              sqlite
            ];
          };
        }
      );

      # Native multi-instance NixOS module for server / desktop
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.get-done;
        in
        {
          options.services.get-done = {
            enable = lib.mkEnableOption "Get Done Server & Web Daemon";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
              description = "The Get Done package to use.";
            };

            instances = lib.mkOption {
              type = lib.types.attrsOf (lib.types.submodule ({ name, config, ... }: {
                options = {
                  port = lib.mkOption {
                    type = lib.types.port;
                    description = "HTTP listening port for this Get Done instance.";
                  };

                  host = lib.mkOption {
                    type = lib.types.str;
                    default = "127.0.0.1";
                    description = "IP address on which the instance listens.";
                  };

                  dataDir = lib.mkOption {
                    type = lib.types.path;
                    default = if (name == "default" || name == "perso") then "/var/lib/getdone" else "/var/lib/getdone-${name}";
                    description = "Data directory of the Get Done instance.";
                  };

                  dbPath = lib.mkOption {
                    type = lib.types.path;
                    default = "${config.dataDir}/getdone.db";
                    description = "Path to the SQLite database for this instance.";
                  };

                  googleMapsKey = lib.mkOption {
                    type = lib.types.nullOr lib.types.str;
                    default = null;
                    description = "Google Places / Maps API key for address autocomplete.";
                  };

                  noAuth = lib.mkOption {
                    type = lib.types.bool;
                    default = false;
                    description = "Disable password authentication.";
                  };

                  user = lib.mkOption {
                    type = lib.types.str;
                    default = "get-done";
                    description = "System user under which to run the instance.";
                  };

                  group = lib.mkOption {
                    type = lib.types.str;
                    default = "get-done";
                    description = "System group under which to run the instance.";
                  };

                  openFirewall = lib.mkOption {
                    type = lib.types.bool;
                    default = false;
                    description = "Automatically open the port in the NixOS firewall.";
                  };
                };
              }));
              default = {};
              description = "Definition of independent Get Done instances.";
            };
          };

          config = lib.mkIf (cfg.enable && cfg.instances != {}) {
            networking.firewall.allowedTCPPorts = lib.concatLists (
              lib.mapAttrsToList (_: inst: lib.optional inst.openFirewall inst.port) cfg.instances
            );

            users.users = lib.mkIf (lib.any (inst: inst.user == "get-done") (lib.attrValues cfg.instances)) {
              get-done = {
                isSystemUser = true;
                group = "get-done";
                home = "/var/lib/getdone";
                createHome = true;
                description = "Get Done daemon user";
              };
            };

            users.groups = lib.mkIf (lib.any (inst: inst.group == "get-done") (lib.attrValues cfg.instances)) {
              get-done = {};
            };

            systemd.services = lib.mapAttrs' (name: inst:
              let
                serviceName = if name == "default" then "getdone" else "getdone-${name}";
              in
              lib.nameValuePair serviceName {
                description = "Get Done Personal Task Manager Daemon (${name})";
                after = [ "network.target" ];
                wantedBy = [ "multi-user.target" ];

                serviceConfig = {
                  ExecStart = "${cfg.package}/bin/get-done -host ${inst.host} -port ${toString inst.port} -data-dir ${toString inst.dataDir} -db ${toString inst.dbPath}"
                    + lib.optionalString (inst.googleMapsKey != null) " -google-maps-key ${inst.googleMapsKey}"
                    + lib.optionalString inst.noAuth " -no-auth";
                  Restart = "always";
                  RestartSec = 3;
                  User = inst.user;
                  Group = inst.group;
                  StateDirectory = lib.removePrefix "/var/lib/" (toString inst.dataDir);
                  WorkingDirectory = toString inst.dataDir;
                };
              }
            ) cfg.instances;
          };
        };
    in
    systemOutputs // {
      nixosModules.default = nixosModule;
      nixosModules.get-done = nixosModule;
      overlays.default = final: prev: {
        get-done = self.packages.${final.system}.default;
      };
    };
}
