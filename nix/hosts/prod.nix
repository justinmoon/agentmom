{ self }:
{ ... }:

{
  imports = [ self.nixosModules.agentmomWeb ];

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

    smolvm.name = "agentmom-web-prod";
  };
}
