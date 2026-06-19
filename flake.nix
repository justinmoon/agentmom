{
  description = "Agent Granny 2: a lean Pi-backed local web shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f { pkgs = nixpkgs.legacyPackages.${system}; inherit system; });
    in {
      devShells = forAllSystems ({ pkgs, ... }: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            just
            nodejs_24
          ];

          shellHook = ''
            export IN_NIX_SHELL=1
          '';
        };
      });

      packages = forAllSystems ({ pkgs, ... }: rec {
        agentgranny2 = pkgs.callPackage ./nix/package.nix { };
        default = agentgranny2;
      });

      apps = forAllSystems ({ pkgs, system, ... }: {
        default = {
          type = "app";
          program = "${self.packages.${system}.agentgranny2}/bin/agentgranny2";
        };
      });
    };
}
