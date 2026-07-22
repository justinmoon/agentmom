{
  description = "Agent Mom: a lean Pi-backed web shell (server + sandboxes on Fly.io)";

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
            git
            just
            nodejs_24
            flyctl
          ];

          shellHook = ''
            export IN_NIX_SHELL=1
          '';
        };
      });
    };
}
