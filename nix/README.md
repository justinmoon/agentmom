# Agent Mom Nix deployment

This repo owns the deployable service shape: app package, systemd unit, Podman,
smolvm, state directories, and optional same-host Caddy routes.

Production deploys use Colmena:

```bash
just deploy-prod
```

That applies the `mom-1` NixOS host from this repo and then runs a small health
check against the local service on the host.

The equivalent direct NixOS switch is:

```bash
nixos-rebuild switch --flake .#mom-1 --target-host mom-1
```

If another repo owns the surrounding host config, it should only import one of
these modules:

```nix
inputs.agentmom.nixosModules.stageHost
inputs.agentmom.nixosModules.prodHost
```

or import the base module and set options directly:

```nix
{
  imports = [ inputs.agentmom.nixosModules.agentmomWeb ];

  services.agentmomWeb = {
    enable = true;
    stateDir = "/data/agentmom-web";
    workspaceDir = "/data/agentmom-web/workspace";
    openRouterKeyFile = "/run/agenix/agentmom-openrouter-api-key";
    deploymentBaseDomain = "mom.agentmom.xyz";

    caddy = {
      enable = true;
      publicDomain = "agentmom.xyz";
    };
  };
}
```

The OpenRouter key is passed with systemd credentials, so the source secret can
stay root-only. Podman is enabled by the module and the service user gets
subuid/subgid ranges for rootless container builds.

The stage and prod host modules assume Caddy runs on the same host as the app.
If DNS still points at a separate proxy host, that proxy can import a tiny
repo-owned Caddy profile later, but the app host should still use this module.
