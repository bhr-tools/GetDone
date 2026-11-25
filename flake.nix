{
  description = "Get Done — Minimalist Todo List with Rosé Pine design & Vim navigation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    kit = {
      url = "github:bhr-tools/kit";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, kit }:
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
            getdone = pkgs.buildGoModule {
              pname = "getdone";
              version = "1.1.0";
              src = ./.;

              subPackages = [ "cmd/server" ];
              vendorHash = null;

              postInstall = ''
                if [ -f "$out/bin/server" ]; then
                  mv "$out/bin/server" "$out/bin/getdone"
                fi
              '';

              meta = with pkgs.lib; {
                description = "Get Done — Minimalist Todo List with Rosé Pine design & Vim navigation";
                homepage = "https://github.com/bhr-tools/GetDone";
                license = licenses.mit;
                mainProgram = "getdone";
              };
            };
            default = getdone;
          };

          apps = rec {
            getdone = flake-utils.lib.mkApp {
              drv = self.packages.${system}.getdone;
              name = "getdone";
            };
            default = getdone;
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

      # Multi-instance NixOS module, shared by the apps (kit/nix/app-module.nix).
      nixosModule = kit.lib.mkAppModule {
        name = "getdone";
        title = "Get Done";
        package = pkgs: self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        dataDir = name: if name == "default" || name == "perso" then "/var/lib/getdone" else "/var/lib/getdone-${name}";
      };
    in
    systemOutputs // {
      nixosModules.default = nixosModule;
      nixosModules.getdone = nixosModule;
      overlays.default = final: prev: {
        getdone = self.packages.${final.stdenv.hostPlatform.system}.default;
      };
    };
}
