{
  description = "Agent Mom: a lean Pi-backed local web shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    agenix = {
      url = "github:ryantm/agenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    colmena = {
      url = "github:nix-community/colmena";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, agenix, disko, colmena, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f { pkgs = nixpkgs.legacyPackages.${system}; inherit system; });
      mkHostModules = module: [
        agenix.nixosModules.default
        disko.nixosModules.disko
        module
      ];
      mkHost = module:
        nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          specialArgs = { inherit self; };
          modules = mkHostModules module;
        };
      mkColmenaNode = { module, targetHost, tags }: {
        imports = mkHostModules module;
        deployment = {
          inherit targetHost tags;
          targetUser = "justin";
          buildOnTarget = true;
          replaceUnknownProfiles = true;
        };
      };
    in {
      devShells = forAllSystems ({ pkgs, system, ... }: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            git
            just
            nodejs_24
            podman
            agenix.packages.${system}.default
            colmena.packages.${system}.colmena
          ];

          shellHook = ''
            export IN_NIX_SHELL=1
          '';
        };
      });

      packages = forAllSystems ({ pkgs, ... }:
        let
          agentmom = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit agentmom;
          default = agentmom;
        });

      apps = forAllSystems ({ pkgs, system, ... }: {
        default = {
          type = "app";
          program = "${self.packages.${system}.agentmom}/bin/agentmom";
        };
      });

      nixosModules.default = self.nixosModules.agentmomWeb;
      nixosModules.agentmom = self.nixosModules.agentmomWeb;
      nixosModules.agentmomWeb = import ./nix/module.nix { inherit self; };
      nixosModules.prodHost = import ./nix/hosts/prod.nix { inherit self; };

      nixosConfigurations.compute = mkHost ./nix/hosts/compute/configuration.nix;
      nixosConfigurations.mom-1 = mkHost ./nix/hosts/mom-1/configuration.nix;

      colmenaHive = colmena.lib.makeHive {
        meta = {
          name = "agentmom";
          description = "Agent Mom production host";
          allowApplyAll = false;
          nixpkgs = import nixpkgs {
            system = "x86_64-linux";
            config.allowUnfree = true;
          };
          specialArgs = { inherit self; };
        };

        # Decommissioning after the 2026-07-21 migration; service disabled.
        # Tailscale IP because the "mom-1" ssh alias pins the public IP,
        # which is not reachable from every network.
        mom-1 = mkColmenaNode {
          module = ./nix/hosts/mom-1/configuration.nix;
          targetHost = "100.118.64.112";
          tags = [ "agentmom" "old-prod" ];
        };

        # The production host (agentmom.xyz) since 2026-07-21. Renamed
        # compute 2026-07-22: it doubles as the shared VM-runner substrate,
        # and the host identity follows the box, not the app.
        compute = mkColmenaNode {
          module = ./nix/hosts/compute/configuration.nix;
          targetHost = "135.181.179.143";
          tags = [ "agentmom" "prod" ];
        };
      };
    };
}
